import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { STORAGE } from '../lib/storage-keys';
import { WsClient, type WsStatus } from '../lib/ws';
import { WS } from '../lib/ws-types';
import { api } from '../lib/api';
import { patchAdapterPrefs, loadAdapterPrefs } from '../lib/adapter-prefs';
import { stripMarker } from '@/lib/content-utils';
import { parseAskQuestionInput } from '@/lib/ask-question-utils';

export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'plan' | 'interrupted';
  content: any[];
};

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: any;
  decisionReason?: string;
};

export type InteractivePrompt = {
  requestId: string;
  promptType: string;
  title: string;
  description: string;
  toolName?: string;
  toolInput?: any;
  options?: { value: string; label: string }[];
  textInput?: { placeholder?: string };
};

export type ToolStatus = {
  toolUseId: string;
  toolName: string;
  input: any;
  status: 'running' | 'success' | 'error' | 'interrupted';
  result?: any;
  parentToolUseId?: string;
};

/** Check if message content contains an interrupt marker */
function isInterruptContent(content: any): boolean {
  const arr = Array.isArray(content) ? content : typeof content === 'string' ? [content] : [];
  return arr.some((b: any) => {
    const text = typeof b === 'string' ? b : (b.text || '');
    return text.includes('[Request interrupted by user');
  });
}

/** Mark all running tools with a terminal status */
function markToolsAs(status: 'success' | 'interrupted') {
  return (prev: Map<string, ToolStatus>): Map<string, ToolStatus> => {
    let changed = false;
    for (const [, tool] of prev) {
      if (tool.status === 'running') { changed = true; break; }
    }
    if (!changed) return prev;
    const next = new Map(prev);
    for (const [id, tool] of next) {
      if (tool.status === 'running') next.set(id, { ...tool, status });
    }
    return next;
  };
}

const SESSION_ERROR_LABELS: Record<string, string> = {
  rate_limit: 'Rate limited — please wait',
  authentication_failed: 'Authentication failed',
  billing_error: 'Billing error',
  server_error: 'Server error',
  max_output_tokens: 'Max output tokens reached',
};

function convertMessages(msgs: any[]): ChatMessage[] {
  const converted: ChatMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string'
        ? [{ type: 'text', text: stripMarker(msg.content) }]
        : (msg.content || []).map((b: any) =>
            b.type === 'text' ? { ...b, text: stripMarker(b.text || '') } : b
          );
      if (isInterruptContent(content)) {
        converted.push({ id: msg.id, role: 'interrupted', content: [] });
        continue;
      }
      converted.push({ id: msg.id, role: 'user', content });
    } else if (msg.role === 'assistant') {
      converted.push({ id: msg.id, role: 'assistant', content: msg.content || [] });
    } else if (msg.role === 'plan') {
      converted.push({ id: msg.id, role: 'plan', content: [{ type: 'text', text: msg.content }] });
    }
  }
  return converted;
}

export interface ReviewInfo {
  reviewId: string;
  childSessionId: string;
  childCliSessionId: string;
  childAdapter: string;
  anchorMessageId?: string;
  reviewTitle?: string;
  prompt?: string;
  permissionMode?: string;
}

export function useChat(initialSessionId?: string, cwd?: string, initialAdapter?: string, initialPrompt?: string, initialPermissionMode?: string) {
  // --- State ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [thinkingStatus, setThinkingStatus] = useState<{ text: string; detail: string | null } | null>(null);
  // Tool state precedence (highest → lowest):
  // 1. abort() → 'interrupted' (immediate, overrides everything)
  // 2. WS.TOOL_DONE (hook) → 'success'/'error' (instant from PostToolUse)
  // 3. WS.TOOL_UPDATES (JSONL) → fallback, only updates tools still in 'running'
  // 4. WS.TURN_COMPLETE → marks remaining 'running' tools as 'success' (cleanup)
  const [toolStatuses, setToolStatuses] = useState<Map<string, ToolStatus>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [pendingResponse, setPendingResponse] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [interactivePrompt, setInteractivePrompt] = useState<InteractivePrompt | null>(null);
  // True when the most recent turn was interrupted — used for input placeholder
  const [interrupted, setInterrupted] = useState(false);
  // If adapter is known (from prop or URL), use immediately. Otherwise null → wait for server.
  const knownAdapter = initialAdapter || null;
  const initialPrefs = knownAdapter ? loadAdapterPrefs(knownAdapter) : null;

  const [model, setModel] = useState<string>(initialPrefs?.model || '');
  const [permissionMode, setPermissionMode] = useState<string>(initialPermissionMode || initialPrefs?.permissionMode || 'default');
  const [effort, setEffort] = useState<string>(initialPrefs?.effort || 'high');
  const [sessionStatus, setSessionStatus] = useState<{
    contextPercent: number | null;
    model: string | null;
    cost: number | null;
  } | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState<string | null>(knownAdapter);
  const [adapterConfig, setAdapterConfig] = useState<{
    models: { value: string; label: string; contextWindow: number }[];
    permissionModes: { value: string; label: string }[];
    effortLevels: { value: string; label: string }[];
    effortLabel: string;
    capabilities?: {
      supportsPermissionModes: boolean;
      permissionModeType?: 'cycle' | 'toggle';
    };
  } | null>(null);
  const [activeReviews, setActiveReviews] = useState<ReviewInfo[]>([]);

  const [activeReviewPanel, setActiveReviewPanel] = useState<'expanded' | 'minimized'>('expanded');
  const [historyReview, setHistoryReview] = useState<any>(null);

  const queuedRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const interruptedRef = useRef(false);
  const wsRef = useRef<WsClient | null>(null);
  const actualSendRef = useRef<(text: string) => void>(() => {});
  const clientIdRef = useRef<string | null>(null);
  const selectedAdapterRef = useRef<string | null>(selectedAdapter);
  selectedAdapterRef.current = selectedAdapter;

  streamingRef.current = streaming;
  interruptedRef.current = interrupted;
  queuedRef.current = queuedMessage;

  // --- Drain queued message ---
  const drainQueue = useCallback(() => {
    if (queuedRef.current) {
      const queued = queuedRef.current;
      queuedRef.current = null;
      setQueuedMessage(null);
      setTimeout(() => actualSendRef.current(queued), 100);
    }
  }, []);

  // --- WebSocket Message Handler ---
  const handleWsMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case WS.SESSION_CREATED:
        setSessionId(msg.sessionId);
        if (msg.adapter) {
          setSelectedAdapter(msg.adapter);
          const prefs = loadAdapterPrefs(msg.adapter);
          if (!knownAdapter) {
            // First time learning adapter — initialize prefs
            setModel(prefs.model || '');
            setPermissionMode(msg.permissionMode || prefs.permissionMode || 'default');
            setEffort(prefs.effort || 'high');
          } else {
            if (msg.permissionMode) setPermissionMode(msg.permissionMode);
          }
        } else {
          if (msg.permissionMode) setPermissionMode(msg.permissionMode);
        }
        break;

      case WS.CLIENT_ID:
        clientIdRef.current = msg.clientId;
        break;

      // Pane monitor: streaming text preview (ephemeral, replaces previous)
      // Don't set streaming=true here — it's already true from sending the query.
      // Setting it here would re-enable streaming after turn-complete if pane still has text.
      case WS.TEXT_DELTA:
        if (streamingRef.current) {
          setStreamingText(msg.text || '');
        }
        break;

      // Pane monitor: thinking indicator
      case WS.THINKING:
        if (streamingRef.current) {
          setThinkingStatus({ text: msg.text, detail: msg.detail || null });
        }
        break;

      // Hook: tool execution started
      case WS.TOOL_START:
        // Don't add tools after abort — they're stale hook events
        if (!streamingRef.current) break;
        setToolStatuses(prev => {
          const next = new Map(prev);
          next.set(msg.toolId, {
            toolUseId: msg.toolId,
            toolName: msg.toolName,
            input: msg.input,
            status: 'running',
          });
          return next;
        });
        break;

      // Hook: tool execution finished (success via PostToolUse, failure via PostToolUseFailure)
      case WS.TOOL_DONE:
        setToolStatuses(prev => {
          const existing = prev.get(msg.toolId);
          if (!existing || existing.status !== 'running') return prev;
          const next = new Map(prev);
          next.set(msg.toolId, {
            ...existing,
            status: msg.result?.is_interrupt ? 'interrupted' : msg.result?.is_error ? 'error' : 'success',
            result: msg.result,
          });
          return next;
        });
        // AskUserQuestion completed — dismiss overlay on all clients
        // Guard: only dismiss if the current overlay IS a question type
        // (a new prompt may have arrived between answer and TOOL_DONE)
        if (msg.toolName === 'AskUserQuestion') {
          setInteractivePrompt((prev) =>
            prev?.promptType === 'question' ? null : prev
          );
        }
        break;

      // JSONL watcher: complete messages (single source of truth)
      case WS.MESSAGE_COMPLETE:
        if (msg.messages && Array.isArray(msg.messages)) {
          // Skip user messages — already added locally when sent
          // But detect interrupt markers and convert to { role: 'interrupted' }
          const converted: ChatMessage[] = [];
          for (const m of msg.messages) {
            if (m.role === 'user') {
              if (isInterruptContent(m.content)) {
                converted.push({ role: 'interrupted', content: [] });
                setInterrupted(true);
                continue;
              }
              // Skip only if this client sent it (already shown via optimistic UI)
              if (m.senderClientId && m.senderClientId === clientIdRef.current) continue;
            }
            const c = convertMessages([m]);
            converted.push(...c);
          }
          if (converted.length > 0) {
            setMessages(prev => [...prev, ...converted]);
            setStreamingText('');
            setThinkingStatus(null);
            if (converted.some(m => m.role === 'assistant')) setPendingResponse(false);
          }
        }
        break;

      // JSONL watcher: tool status updates from transcript parser
      case WS.TOOL_UPDATES:
        if (msg.tools) {
          setToolStatuses(prev => {
            let changed = false;
            const next = new Map(prev);
            for (const [id, tool] of Object.entries(msg.tools as Record<string, any>)) {
              const existing = next.get(id);
              // Don't overwrite terminal states (interrupted/success/error) with 'running'
              if (existing && existing.status !== 'running') continue;
              // Only update existing tools (registered via TOOL_START) — don't add unknown
              // 'running' tools from stale watcher data (old turns re-parsed by JSONL watcher)
              if (!existing && tool.status === 'running') continue;
              next.set(id, { ...tool, toolName: tool.toolName || tool.name });
              changed = true;
            }
            return changed ? next : prev;
          });
        }
        break;

      // Stop hook: turn complete, ready for next input
      case WS.TURN_COMPLETE:
        setStreaming(false);
        setPendingResponse(false);
        setStreamingText('');
        setThinkingStatus(null);
        setInteractivePrompt(null);
        // Mark remaining running tools: if user interrupted → 'interrupted', otherwise → 'success'
        setToolStatuses(markToolsAs(interruptedRef.current ? 'interrupted' : 'success'));
        streamingRef.current = false;
        drainQueue();
        break;

      case WS.REVIEW_STARTED:
        console.log(`[WS.REVIEW_STARTED] reviewId=${msg.reviewId?.slice(0,8)} childSid=${msg.childSessionId?.slice(0,8)} adapter=${msg.childAdapter}`);
        setActiveReviews(prev => {
          const isDup = prev.some(r => r.reviewId === msg.reviewId);
          console.log(`[WS.REVIEW_STARTED] dedup check: ${isDup ? 'DUPLICATE, skipping' : 'NEW, adding'}`);
          if (isDup) return prev;
          return [...prev, {
            reviewId: msg.reviewId,
            childSessionId: msg.childSessionId,
            childCliSessionId: msg.childCliSessionId,
            childAdapter: msg.childAdapter,
            anchorMessageId: msg.anchorMessageId,
            reviewTitle: msg.reviewTitle,
          }];
        });
        setActiveReviewPanel('expanded');
        break;

      case WS.REVIEW_ENDED:
        setActiveReviews(prev => prev.filter(r => r.reviewId !== msg.reviewId));
        break;

      // Unified interactive prompt (from Gemini/Codex pane monitors or session-manager conversion)
      case WS.INTERACTIVE_PROMPT:
        setInteractivePrompt({
          requestId: msg.requestId,
          promptType: msg.promptType,
          title: msg.title || '',
          description: msg.description || '',
          toolName: msg.toolName,
          toolInput: msg.toolInput,
          options: msg.options,
          textInput: msg.textInput,
        });
        break;

      // Another client answered the prompt — dismiss overlay
      case WS.PROMPT_DISMISSED:
        setInteractivePrompt(prev =>
          prev?.requestId === msg.requestId ? null : prev
        );
        break;

      // Legacy hook: permission request — convert to InteractivePrompt
      case WS.PERMISSION_REQUEST: {
        const isAsk = msg.toolName === 'AskUserQuestion';
        if (isAsk) {
          const parsed = parseAskQuestionInput(msg.input);
          setInteractivePrompt({
            requestId: msg.requestId,
            promptType: 'question',
            title: parsed.header || 'Question',
            description: parsed.question,
            toolName: msg.toolName,
            toolInput: msg.input,
            options: parsed.options,
            textInput: parsed.options ? undefined : { placeholder: 'Enter your response...' },
          });
        } else {
          setInteractivePrompt({
            requestId: msg.requestId,
            promptType: 'permission',
            title: 'Permission Request',
            description: `${msg.toolName} wants to execute`,
            toolName: msg.toolName,
            toolInput: msg.input,
            options: [{ value: 'allow', label: 'Allow' }, { value: 'allow_session', label: 'Allow All' }, { value: 'deny', label: 'Deny' }],
          });
        }
        break;
      }

      // Legacy: another client answered the permission request — dismiss overlay
      case WS.PERMISSION_DISMISSED:
        setInteractivePrompt(prev =>
          prev?.requestId === msg.requestId ? null : prev
        );
        break;

      case WS.SESSION_STATE:
        if (msg.streaming) {
          if (!streamingRef.current) {
            setInterrupted(false);
          }
          setStreaming(true);
          setPendingResponse(true);
          streamingRef.current = true;
        }
        break;

      // Full history load on reconnection (replaces, not appends)
      case WS.HISTORY_LOAD:
        if (msg.messages && Array.isArray(msg.messages)) {
          setMessages(convertMessages(msg.messages));
        }
        setPendingResponse(false);
        break;

      case WS.STATUS_UPDATE:
        setSessionStatus(prev => {
          if (prev &&
              prev.contextPercent === msg.contextPercent &&
              prev.model === msg.model &&
              prev.cost === msg.cost) return prev;
          return { contextPercent: msg.contextPercent, model: msg.model, cost: msg.cost };
        });
        break;

      case WS.MODE_UPDATED:
        setPermissionMode(msg.mode);
        if (selectedAdapterRef.current) patchAdapterPrefs(selectedAdapterRef.current, { permissionMode: msg.mode });
        if (msg.mode === 'bypassPermissions' || msg.mode === 'plan') {
          setInteractivePrompt(null);
        }
        break;

      case WS.COMPACTING:
        setThinkingStatus({ text: 'Compacting context...', detail: '' });
        break;

      case WS.COMPACT_DONE:
        setThinkingStatus(null);
        break;

      case WS.SESSION_ERROR: {
        const errorMsg = SESSION_ERROR_LABELS[msg.errorType] || msg.errorDetails || msg.errorType;
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: [{ type: 'text', text: `⚠️ ${errorMsg}` }],
        }]);
        break;
      }

      case WS.SESSION_ENDED:
        setStreaming(false);
        setPendingResponse(false);
        streamingRef.current = false;
        break;

      case WS.ERROR:
        setStreaming(false);
        setPendingResponse(false);
        streamingRef.current = false;
        console.error('Server error:', msg.error);
        break;
    }
  }, [drainQueue]);

  // --- WebSocket Connection ---
  useEffect(() => {
    const token = localStorage.getItem(STORAGE.TOKEN);
    if (!token) return;
    const client = new WsClient(token, handleWsMessage, setWsStatus);
    wsRef.current = client;
    if (initialSessionId) {
      client.setActiveSession(initialSessionId, selectedAdapter ?? undefined);
    }
    client.connect();
    return () => {
      client.disconnect();
      wsRef.current = null;
      clientIdRef.current = null;
    };
  }, [handleWsMessage, initialSessionId]);

  // Auto-send initialPrompt when WS connects (for new sessions only)
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (initialPrompt && !initialSessionId && !initialPromptSent.current && wsStatus === 'connected') {
      initialPromptSent.current = true;
      actualSendRef.current(initialPrompt);
    }
  }, [initialPrompt, initialSessionId, wsStatus]);

  // Keep WsClient's activeAdapter in sync so reconnect sends correct adapter hint
  useEffect(() => {
    if (wsRef.current && sessionId) {
      wsRef.current.setActiveSession(sessionId, selectedAdapter ?? undefined);
    }
  }, [sessionId, selectedAdapter]);

  // --- Fetch adapter config (models, permission modes) ---
  useEffect(() => {
    if (selectedAdapter) api.adapterConfig(selectedAdapter).then(setAdapterConfig).catch(console.error);
  }, [selectedAdapter]);

  // --- Send Message ---
  const actualSend = useCallback((text: string) => {
    if (!selectedAdapter) return;
    if (!text.trim() || !wsRef.current) return;
    streamingRef.current = true;
    setMessages(prev => [
      ...prev,
      { role: 'user', content: [{ type: 'text', text }] },
    ]);
    setStreaming(true);
    setPendingResponse(true);
    setToolStatuses(new Map()); // Clear tools for new turn
    setInterrupted(false); // Reset placeholder
    wsRef.current.send({
      type: WS.QUERY,
      prompt: text,
      options: {
        adapter: selectedAdapter,
        cwd: cwd || undefined,
        model,
        sessionId: sessionId || undefined,
        permissionMode,
        effort,
      },
    });
  }, [cwd, model, sessionId, permissionMode, effort, selectedAdapter]);

  actualSendRef.current = actualSend;

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    if (streamingRef.current) {
      queuedRef.current = text;
      setQueuedMessage(text);
    } else {
      actualSend(text);
    }
  }, [actualSend]);

  const clearQueuedMessage = useCallback(() => {
    queuedRef.current = null;
    setQueuedMessage(null);
  }, []);

  // --- Permission / Question Response ---
  const respondPermission = useCallback((requestId: string, behavior: 'allow' | 'allow_session' | 'deny', message?: string) => {
    wsRef.current?.send({
      type: WS.PERMISSION_RESPONSE,
      requestId,
      behavior,
      message,
    });
    setInteractivePrompt(null);
  }, []);

  const respondAsk = useCallback((requestId: string, response: string) => {
    wsRef.current?.send({
      type: WS.ASK_RESPONSE,
      requestId,
      response,
    });
    setInteractivePrompt(null);
  }, []);

  const respondPrompt = useCallback((requestId: string, selectedOption?: string, textValue?: string) => {
    wsRef.current?.send({
      type: WS.PROMPT_RESPONSE,
      requestId,
      selectedOption,
      textValue,
    });
    setInteractivePrompt(null);
  }, []);

  // --- Plan Response ---
  const respondPlan = useCallback((optionIndex: number, text?: string) => {
    // Enter streaming mode — CLI will start executing tools after approval
    setStreaming(true);
    setPendingResponse(true);
    streamingRef.current = true;
    setToolStatuses(new Map());
    wsRef.current?.send({
      type: WS.PLAN_RESPONSE,
      sessionId,
      optionIndex,
      text,
    });
  }, [sessionId]);

  // --- Abort ---
  const abort = useCallback(() => {
    wsRef.current?.send({ type: WS.ABORT, sessionId });
    setStreaming(false);
    setPendingResponse(false);
    setStreamingText('');
    setThinkingStatus(null);
    setInteractivePrompt(null);
    setInterrupted(true); // Immediately mark as interrupted for tool card fallback
    setToolStatuses(markToolsAs('interrupted'));
  }, [sessionId]);

  // --- Settings ---
  const updateModel = useCallback((m: string) => {
    setModel(m);
    if (selectedAdapter) patchAdapterPrefs(selectedAdapter, { model: m });
    if (sessionId) {
      wsRef.current?.send({ type: WS.SET_MODEL, sessionId, model: m });
    }
  }, [sessionId, selectedAdapter]);

  const updateAdapter = useCallback((adapter: string) => {
    setSelectedAdapter(adapter);
    localStorage.setItem(STORAGE.ADAPTER, adapter);
    const prefs = loadAdapterPrefs(adapter);
    if (prefs.model) setModel(prefs.model);
    if (prefs.permissionMode) setPermissionMode(prefs.permissionMode);
    if (prefs.effort) setEffort(prefs.effort);
  }, []);

  const updatePermissionMode = useCallback((m: string) => {
    setPermissionMode(m);
    if (selectedAdapter) patchAdapterPrefs(selectedAdapter, { permissionMode: m });
    if (sessionId) {
      wsRef.current?.send({ type: WS.SET_PERMISSION_MODE, sessionId, mode: m });
    }
  }, [sessionId, selectedAdapter]);

  const liveStatus = useMemo(() => {
    if (thinkingStatus) return { type: 'thinking' as const, text: thinkingStatus.detail ? `${thinkingStatus.text} (${thinkingStatus.detail})` : thinkingStatus.text };
    if (streamingText) return { type: 'streaming' as const, text: streamingText };
    return null;
  }, [thinkingStatus, streamingText]);

  return {
    messages, toolStatuses, streaming, pendingResponse, wsStatus, sessionId, liveStatus,
    interrupted, sessionStatus, adapterConfig, selectedAdapter,
    interactivePrompt, model, permissionMode, effort,
    queuedMessage, clearQueuedMessage,
    activeReviews, setActiveReviews, activeReviewPanel, setActiveReviewPanel,
    historyReview, setHistoryReview,
    sendMessage, respondPermission, respondAsk, respondPrompt, respondPlan, abort,
    updateModel, updatePermissionMode, updateAdapter,
  };
}
