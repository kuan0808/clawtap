import { get as getAdapter, getAll as getAllAdapters, DEFAULT_ADAPTER } from './adapters/registry.js';
import type { IAdapter } from './adapters/interface.js';
import { WS, PLAN_OPTION } from './ws-types.js';
import type { ClientMessage, QueryOptions, PermissionBehavior } from './types/messages.js';
import { sendPush, incrementPending, clearPending, getPendingSessions } from './push.js';
import { basename } from 'path';
import type { ClientConnection } from './transport/client-connection.js';
import { sessionReviews, sessionAdapters } from './db.js';
import { parseAskQuestionInput } from './adapters/shared/ask-question-utils.js';

/** Push notification options */
interface PushOptions {
  title: string;
  body: string;
  tagPrefix: string;
}

/** Send a push notification for a session event — only if nobody is viewing this session. */
function triggerPush(adapter: IAdapter, sessionId: string, { title, body, tagPrefix }: PushOptions): void {
  const clients = sessionClients.get(sessionId);
  if (clients && clients.size > 0) return;

  // Skip push for child review sessions
  if (sessionReviews.getAllChildIds().has(sessionId)) return;

  const session = adapter.getSession(sessionId) as { cwd?: string } | null;
  const projectName = basename(session?.cwd || '') || 'Unknown';
  const badge = incrementPending(sessionId);
  sendPush({
    title,
    body: `${body} in ${projectName}`,
    tag: `${tagPrefix}-${sessionId}`,
    data: { sessionId, badge },
  }).catch((err: Error) => console.error('[push]', err.message));
}

/**
 * SessionManager — bridges adapter events to connected clients.
 *
 * Responsibilities:
 * - Client lifecycle: register, unregister, reconnect
 * - Event routing: adapter events -> client broadcasts
 * - Session routing: new/resume/reconnect
 *
 * Transport-agnostic: works with ClientConnection, never raw WebSocket.
 * Adapter-generic: no direct imports of any specific adapter.
 */

const sessionClients = new Map<string, Set<ClientConnection>>(); // sessionId -> Set<conn>
const sessionAdapterMap = new Map<string, string>();              // sessionId -> adapterName
// Codex sessions rekey from temp key to real UUID. If rekey happens before the
// WS client connects (race condition with fast direct-match), the client registers
// under the old key. This alias map resolves old → new so late-connecting clients
// find the correct session.
const rekeyAliases = new Map<string, string>();                   // oldKey -> newKey

export function setupSessionManager(): void {
  const adapters = getAllAdapters();
  for (const [name, adapter] of adapters) {
    // Bridge adapter events -> client broadcasts (identical for every adapter)
    adapter.on('streaming-text', (sessionId: string, text: string) => {
      broadcast(sessionId, { type: WS.TEXT_DELTA, text });
    });

    adapter.on('thinking', (sessionId: string, thinking: { text: string; detail?: string }) => {
      broadcast(sessionId, { type: WS.THINKING, text: thinking.text, detail: thinking.detail });
    });

    adapter.on('tool-start', (sessionId: string, data: { toolName: string; [key: string]: unknown }) => {
      console.log(`[mgr] tool-start: ${data.toolName} for ${sessionId}`);
      broadcast(sessionId, { type: WS.TOOL_START, ...data });
    });

    adapter.on('tool-done', (sessionId: string, data: { toolName: string; [key: string]: unknown }) => {
      console.log(`[mgr] tool-done: ${data.toolName} for ${sessionId}`);
      broadcast(sessionId, { type: WS.TOOL_DONE, ...data });
    });

    adapter.on('new-messages', (sessionId: string, messages: Array<{ role: string; [key: string]: unknown }>) => {
      console.log(`[mgr] new-messages: ${messages.length} msgs (roles: ${messages.map(m => m.role).join(',')}) for ${sessionId}`);
      broadcast(sessionId, { type: WS.MESSAGE_COMPLETE, messages });
    });

    adapter.on('tool-updates', (sessionId: string, tools: Record<string, unknown>) => {
      broadcast(sessionId, { type: WS.TOOL_UPDATES, tools });
    });

    adapter.on('session-idle', (sessionId: string) => {
      // Stop hook fired — do a final poll before broadcasting turn-complete
      adapter.flushMessages(sessionId);
      // Small delay to ensure the pollNow result is broadcast first
      setTimeout(() => {
        broadcast(sessionId, { type: WS.TURN_COMPLETE, sessionId });
      }, 100);
      triggerPush(adapter, sessionId, { title: 'Claude finished', body: 'Turn complete', tagPrefix: 'idle' });
    });

    adapter.on('permission-request', (sessionId: string, data: { requestId?: string; toolName?: string; input?: any; [key: string]: unknown }) => {
      // Convert legacy Claude hook event to InteractivePrompt format
      broadcast(sessionId, {
        type: WS.INTERACTIVE_PROMPT,
        requestId: data.requestId || `perm-${Date.now()}`,
        promptType: 'permission',
        title: 'Permission Request',
        description: `${data.toolName || 'Tool'} wants to execute`,
        toolName: data.toolName,
        toolInput: data.input,
        options: [
          { value: 'allow', label: 'Allow' },
          { value: 'allow_session', label: 'Allow All' },
          { value: 'deny', label: 'Deny' },
        ],
      });
      triggerPush(adapter, sessionId, { title: 'Permission needed', body: data.toolName || 'tool', tagPrefix: 'perm' });
    });

    adapter.on('ask-question', (sessionId: string, data: { requestId?: string; toolName?: string; input?: any; [key: string]: unknown }) => {
      const parsed = parseAskQuestionInput(data.input || {});
      broadcast(sessionId, {
        type: WS.INTERACTIVE_PROMPT,
        requestId: data.requestId || `ask-${Date.now()}`,
        promptType: 'question',
        title: parsed.header || 'Question',
        description: parsed.question,
        toolName: 'AskUserQuestion',
        toolInput: data.input || {},
        options: parsed.options,
        textInput: parsed.options ? undefined : { placeholder: 'Enter your response...' },
      });
      triggerPush(adapter, sessionId, { title: 'Question', body: questionText.substring(0, 50) || 'Waiting for answer', tagPrefix: 'ask' });
    });

    adapter.on('interactive-prompt', (sessionId: string, prompt: any) => {
      broadcast(sessionId, { type: WS.INTERACTIVE_PROMPT, ...prompt });
      const pushTitle = prompt.promptType === 'permission' ? 'Permission needed'
        : prompt.promptType === 'question' ? 'Question'
        : prompt.promptType === 'plan' ? 'Plan approval'
        : 'Action needed';
      triggerPush(adapter, sessionId, { title: pushTitle, body: prompt.title || '', tagPrefix: 'prompt' });
    });

    adapter.on('status-update', (sessionId: string, status: Record<string, unknown>) => {
      // Dedup is handled by the adapter — just broadcast
      broadcast(sessionId, { type: WS.STATUS_UPDATE, ...status });
    });

    adapter.on('mode-changed', (sessionId: string, mode: string) => {
      console.log(`[mgr] mode-changed: ${mode} for ${sessionId}`);
      broadcast(sessionId, { type: WS.MODE_UPDATED, mode });
    });

    adapter.on('session-ended', (sessionId: string) => {
      broadcast(sessionId, { type: WS.SESSION_ENDED });

      // Cascade child reviews — BEFORE deleting client set so broadcasts reach clients
      const activeChildren = sessionReviews.getActiveForParent(sessionId);
      for (const child of activeChildren) {
        sessionReviews.endReview(child.id);
        broadcast(sessionId, { type: WS.REVIEW_ENDED, reviewId: child.id });
        const childAdapterObj = getAdapter(child.child_adapter);
        if (childAdapterObj) {
          childAdapterObj.destroySession(child.child_cli_session_id).catch(() => {});
        }
      }

      // THEN clean up maps
      sessionClients.delete(sessionId);
      sessionAdapterMap.delete(sessionId);
      // Clean rekey alias pointing to this session
      for (const [oldKey, newKey] of rekeyAliases) {
        if (newKey === sessionId) rekeyAliases.delete(oldKey);
      }
    });

    adapter.on('session-error', (sessionId: string, data: { errorType?: string; errorDetails?: string; [key: string]: unknown }) => {
      broadcast(sessionId, { type: WS.SESSION_ERROR, ...data });
      triggerPush(adapter, sessionId, {
        title: 'Session Error',
        body: data.errorType === 'rate_limit' ? 'Rate limited' : (data.errorDetails || data.errorType || 'Unknown error'),
        tagPrefix: 'error',
      });
    });

    adapter.on('compacting', (sessionId: string) => {
      broadcast(sessionId, { type: WS.COMPACTING });
    });

    adapter.on('compact-done', (sessionId: string) => {
      broadcast(sessionId, { type: WS.COMPACT_DONE });
    });

    adapter.on('processing-started', (sessionId: string) => {
      broadcast(sessionId, { type: WS.SESSION_STATE, streaming: true });
    });

    // When Codex re-keys a session from temp key to real CLI UUID,
    // move clients and adapter mapping to the new key
    adapter.on('session-rekeyed', (oldKey: string, newKey: string) => {
      // Store alias so late-connecting clients can resolve the old key
      rekeyAliases.set(oldKey, newKey);
      // Move clients from old key to new key
      const clients = sessionClients.get(oldKey);
      if (clients) {
        sessionClients.delete(oldKey);
        sessionClients.set(newKey, clients);
        // Update each client's sessionId
        for (const conn of clients) {
          conn.sessionId = newKey;
        }
      }
      // Move adapter mapping
      const adapterName = sessionAdapterMap.get(oldKey);
      if (adapterName) {
        sessionAdapterMap.delete(oldKey);
        sessionAdapterMap.set(newKey, adapterName);
      }
      // Update any active reviews that reference the old key as child (FIX 3)
      sessionReviews.updateChildCliId(oldKey, newKey);
      // Send SESSION_CREATED with the real UUID — for pendingRekey adapters,
      // this is the ONLY SESSION_CREATED the client receives.
      const resolvedAdapter = getAdapter(adapterName || DEFAULT_ADAPTER);
      if (resolvedAdapter && clients) {
        for (const conn of clients) {
          sendSessionCreated(conn, resolvedAdapter, newKey);
        }
      }
    });

    // Set client checker so adapter can decide whether to intercept hooks
    adapter.setClientChecker((sessionId: string) => {
      const clients = sessionClients.get(sessionId);
      return !!(clients && clients.size > 0);
    });
  }
}

// === Helper: resolve adapter for a session ===

/**
 * Resolve which adapter owns a session.
 * 1. In-memory map (fastest, covers active sessions)
 * 2. SQLite (populated when /api/sessions is fetched, survives restarts)
 * 3. Probe each adapter with getMessages (one-time cost, then cached)
 * Returns null if no adapter recognizes the session.
 */
async function resolveAdapterForSession(sessionId: string): Promise<string | null> {
  // 1. Memory
  const mapped = sessionAdapterMap.get(sessionId);
  if (mapped) return mapped;

  // 2. SQLite
  const persisted = sessionAdapters.get(sessionId);
  if (persisted) {
    sessionAdapterMap.set(sessionId, persisted);
    return persisted;
  }

  // 3. Probe each adapter — runs once per unknown session, then cached
  for (const [name, adapter] of getAllAdapters()) {
    try {
      const { messages } = await adapter.getMessages(sessionId);
      if (messages.length > 0) {
        sessionAdapterMap.set(sessionId, name);
        sessionAdapters.set(sessionId, name);
        return name;
      }
    } catch (err) {
      console.warn(`[resolveAdapter] probe ${name} for ${sessionId.slice(0, 8)} failed:`, (err as Error).message);
    }
  }

  return null;
}

async function getAdapterForSession(conn: ClientConnection, sessionId?: string): Promise<{ adapter: IAdapter | undefined; sid: string }> {
  const sid = sessionId || conn.sessionId || '';
  const name = await resolveAdapterForSession(sid);
  return { adapter: name ? getAdapter(name) : undefined, sid };
}

function sendSessionCreated(conn: ClientConnection, adapter: IAdapter, sessionId: string): void {
  const sessionObj = adapter.getSession(sessionId) as {
    permissionMode?: string;
    approvalPolicy?: string;
    cwd?: string;
  } | null;
  const adapterName = sessionAdapterMap.get(sessionId) || sessionAdapters.get(sessionId);
  send(conn, {
    type: WS.SESSION_CREATED,
    sessionId,
    adapter: adapterName,
    cwd: sessionObj?.cwd,
    permissionMode: sessionObj?.permissionMode || sessionObj?.approvalPolicy,
  });
}

// === Centralized Message Router ===

export async function handleIncomingMessage(conn: ClientConnection, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case WS.QUERY:
      return handleQuery(conn, msg.prompt as string, (msg.options as QueryOptions) || {});
    case WS.PERMISSION_RESPONSE:
      return handlePermissionResponse(conn, msg.requestId as string, {
        behavior: msg.behavior as string,
        alwaysAllow: msg.alwaysAllow as boolean | undefined,
      });
    case WS.ASK_RESPONSE:
      return handleAskResponse(conn, msg.requestId as string, msg.response as string);
    case WS.ABORT:
      return handleAbort(conn, msg.sessionId as string | undefined);
    case WS.RECONNECT:
      return handleReconnect(conn, msg.sessionId as string | undefined);
    case WS.SET_PERMISSION_MODE:
      return handleSetPermissionMode(conn, msg.sessionId as string, msg.mode as string);
    case WS.SET_MODEL:
      return handleSetModel(conn, msg.sessionId as string, msg.model as string);
    case WS.PLAN_RESPONSE:
      return handlePlanResponse(conn, msg.sessionId as string, msg.optionIndex as number, msg.text as string | undefined);
    case WS.PROMPT_RESPONSE:
      return handlePromptResponse(conn, msg.requestId as string, {
        selectedOption: msg.selectedOption as string | undefined,
        textValue: msg.textValue as string | undefined,
      });
    default:
      conn.send({ type: 'error', error: `Unknown message type: ${msg.type}` });
  }
}

// === Message Handlers ===

export async function handleQuery(conn: ClientConnection, prompt: string, options: QueryOptions): Promise<void> {
  let { cwd, model, sessionId, permissionMode, images, adapter: adapterName } = options;
  let adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

  let handle: { sessionId: string; pendingRekey?: boolean };
  if (sessionId) {
    const resolvedName = await resolveAdapterForSession(sessionId);
    if (resolvedName && resolvedName !== (adapterName || DEFAULT_ADAPTER)) {
      adapter = getAdapter(resolvedName)!;
      adapterName = resolvedName;
    }
    handle = await adapter.resumeSession(sessionId, cwd as string, { permissionMode });
  } else {
    handle = await adapter.startSession(cwd || process.cwd(), { model, permissionMode });
  }

  registerSessionAdapter(handle.sessionId, adapterName || DEFAULT_ADAPTER);
  registerClient(conn, handle.sessionId);
  // Adapters with pendingRekey (Codex/Gemini) don't get SESSION_CREATED here —
  // the session-rekeyed handler sends it after rekey with the real UUID.
  if (!handle.pendingRekey) {
    sendSessionCreated(conn, adapter, handle.sessionId);
  }

  // Send the message (images sent as text description for now)
  let messageText = prompt;
  if (!sessionId && adapterName !== 'claude') {
    // New session — prepend marker for Codex UUID matching (Claude already knows its UUID)
    messageText = `[CLAWTAP_REF:${handle.sessionId}]\n${prompt}`;
  }
  if (images && images.length > 0) {
    messageText = messageText + '\n\n' + images.map((img: string) => `[Image: ${img}]`).join('\n');
  }
  await adapter.sendMessage(handle.sessionId, messageText, { clientId: conn.clientId });
}

export async function handlePermissionResponse(conn: ClientConnection, requestId: string, response: { behavior: PermissionBehavior; alwaysAllow?: boolean }): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn);
  if (adapter) {
    adapter.respondPermission(requestId, response.behavior);
    broadcast(sid, { type: WS.PERMISSION_DISMISSED, requestId });
  }
}

export async function handleAskResponse(conn: ClientConnection, requestId: string, answers: string): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn);
  if (adapter) {
    adapter.respondQuestion(requestId, answers);
    broadcast(sid, { type: WS.PERMISSION_DISMISSED, requestId });
  }
}

export async function handlePromptResponse(conn: ClientConnection, requestId: string, response: { selectedOption?: string; textValue?: string }): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn);
  if (adapter) {
    adapter.respondInteractivePrompt(requestId, response.selectedOption, response.textValue);
    broadcast(sid, { type: WS.PROMPT_DISMISSED, requestId });
  }
}

export async function handleAbort(conn: ClientConnection, sessionId?: string): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn, sessionId);
  if (sid && adapter) await adapter.interrupt(sid);
}

export async function handlePlanResponse(conn: ClientConnection, sessionId: string, optionIndex: number, text?: string): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn, sessionId);
  if (!sid || !adapter) return;
  await adapter.respondPlan(sid, optionIndex, text);
  // Broadcast synthetic user message so plan card transitions to read-only on ALL clients
  // Options: 0=bypass (YOLO), 1=manually approve, 2=text feedback
  const labels = ['Plan approved (YOLO).', 'Plan approved.'];
  const msg = optionIndex === PLAN_OPTION.TEXT_FEEDBACK ? (text || 'Rejected.') : (labels[optionIndex] || 'Plan approved.');
  broadcast(sid, { type: WS.MESSAGE_COMPLETE, messages: [{ role: 'user', content: msg }] });
}

export async function handleReconnect(conn: ClientConnection, sessionId?: string): Promise<void> {
  if (!sessionId) return;

  const resolvedId = rekeyAliases.get(sessionId) || sessionId;

  const adapterName = await resolveAdapterForSession(resolvedId);
  if (!adapterName) return;
  const adapter = getAdapter(adapterName);
  if (!adapter) return;

  registerClient(conn, sessionId);
  sessionAdapterMap.set(resolvedId, adapterName);

  // Clear pending push notifications for this session and update badge (only if there were pending)
  if (getPendingSessions()[resolvedId]) {
    const remaining = clearPending(resolvedId);
    sendPush({ data: { badge: remaining } }).catch(() => {});
  }
  // Always send SESSION_CREATED on reconnect — includes permissionMode
  sendSessionCreated(conn, adapter, resolvedId);

  // Send cached status (context %, model, cost) if available
  const lastStatus = adapter.getLastStatus(resolvedId);
  if (lastStatus) {
    send(conn, { type: WS.STATUS_UPDATE, ...lastStatus });
  }

  // Advance watcher past current file position BEFORE loading history —
  // prevents watcher from emitting entries during the async getMessages() read
  // that would duplicate what HISTORY_LOAD delivers
  adapter.syncWatcherPosition(resolvedId);

  // Send current messages from store (full history for reconnection)
  try {
    const { messages } = await adapter.getMessages(resolvedId);
    if (messages.length > 0) {
      send(conn, { type: WS.HISTORY_LOAD, messages });
    }
  } catch {}

  // Notify client if session is actively processing
  if (adapter.isProcessing(resolvedId)) {
    send(conn, { type: WS.SESSION_STATE, streaming: true });
  }

  // Replay pending state (running tools, permission/question overlays)
  const pending = adapter.getReconnectState(resolvedId);
  if (pending.tools) {
    send(conn, { type: WS.TOOL_UPDATES, tools: pending.tools });
  }
  for (const req of pending.pendingRequests) {
    const { type: _type, ...rest } = req as Record<string, unknown>;
    send(conn, { type: WS.PERMISSION_REQUEST, ...rest });
  }

  // Restore active child reviews
  try {
    const activeReviews = sessionReviews.getActiveForParent(resolvedId);
    for (const review of activeReviews) {
      const childAdapterObj = getAdapter(review.child_adapter);
      if (!childAdapterObj) continue;

      if (!childAdapterObj.getSession(review.child_cli_session_id)) {
        sessionReviews.endReview(review.id);
        continue;
      }

      send(conn, {
        type: WS.REVIEW_STARTED,
        reviewId: review.id,
        childSessionId: review.child_cli_session_id,
        childCliSessionId: review.child_cli_session_id,
        childAdapter: review.child_adapter,
        anchorMessageId: review.anchor_message_id,
        reviewTitle: review.review_title,
      });
    }
  } catch (err) {
    console.error('[handleReconnect] Failed to restore child reviews:', err);
  }
}

export async function handleSetModel(conn: ClientConnection, sessionId: string, model: string): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn, sessionId);
  if (adapter && sid) {
    await adapter.switchModel(sid, model);
  }
}

export async function handleSetPermissionMode(conn: ClientConnection, sessionId: string, mode: string): Promise<void> {
  const { adapter, sid } = await getAdapterForSession(conn, sessionId);
  if (!sid || !adapter) return;

  const success = await adapter.switchPermissionMode(sid, mode);
  if (success) {
    broadcast(sid, { type: WS.MODE_UPDATED, mode });
    // Only auto-resolve permissions for cycle-type adapters where we know the exact mode
    const capabilities = adapter.getCapabilities();
    if (capabilities.permissionModeType !== 'toggle') {
      if (mode === 'bypassPermissions') {
        adapter.resolveAllPendingAs(sid, 'allow');
      } else {
        adapter.releaseAllPending(sid);
      }
    }
  }
}

// === Client Management ===

function registerClient(conn: ClientConnection, sessionId: string): void {
  // Resolve rekey alias: if sessionId was a temp key that's been re-keyed, use the new key
  const resolvedId = rekeyAliases.get(sessionId) || sessionId;
  if (resolvedId !== sessionId) {
    send(conn, { type: WS.SESSION_CREATED, sessionId: resolvedId });
  }

  const existingSession = conn.sessionId;
  if (existingSession === resolvedId) {
    const set = sessionClients.get(resolvedId);
    if (set) set.add(conn);
    return;
  }

  // Remove from old session if switching
  if (existingSession) {
    const oldSet = sessionClients.get(existingSession);
    if (oldSet) oldSet.delete(conn);
  }

  conn.sessionId = resolvedId;
  let clients = sessionClients.get(resolvedId);
  if (!clients) {
    clients = new Set();
    sessionClients.set(resolvedId, clients);
  }
  clients.add(conn);

  // Set up disconnect handler (idempotent — ClientConnection fires 'close' once)
  conn.onDisconnect = (c: ClientConnection) => {
    const sid = c.sessionId;
    if (!sid) return;
    const set = sessionClients.get(sid);
    if (set) {
      set.delete(c);
      if (set.size === 0) {
        const adapterName = sessionAdapterMap.get(sid) || DEFAULT_ADAPTER;
        const adapter = getAdapter(adapterName);
        // Only release pending permissions if session is idle — if processing,
        // the client may be refreshing and will reconnect shortly to see the overlay
        if (adapter && !adapter.isProcessing(sid)) {
          adapter.releaseAllPending(sid);
        }
        console.log(`[session-mgr] All clients disconnected from ${sid}, session persists`);
      }
    }
  };
}

// === Broadcasting ===

function send(conn: ClientConnection, message: Record<string, unknown>): void {
  if (conn.shouldReceive(message as any)) conn.send(message as any);
}

function broadcast(sessionId: string, message: Record<string, unknown>): void {
  const clients = sessionClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const json = JSON.stringify(message);
  for (const conn of clients) {
    if (conn.shouldReceive(message as any)) conn.sendRaw(json);
  }
}

// TODO: childCliSessionId is redundant with childSessionId (they are always the same
// CLI UUID now). Remove childCliSessionId from WS protocol and frontend state types.
export function broadcastReviewStarted(parentSessionId: string, review: {
  reviewId: string;
  childSessionId: string;
  childCliSessionId: string;
  childAdapter: string;
  anchorMessageId?: string;
  reviewTitle?: string;
}): void {
  broadcast(parentSessionId, { type: WS.REVIEW_STARTED, ...review });
}

export function broadcastReviewEnded(parentSessionId: string, reviewId: string): void {
  broadcast(parentSessionId, { type: WS.REVIEW_ENDED, reviewId });
}

export function getClientCount(sessionId: string): number {
  const clients = sessionClients.get(sessionId);
  return clients ? clients.size : 0;
}

export function registerSessionAdapter(sessionId: string, adapterName: string): void {
  sessionAdapterMap.set(sessionId, adapterName);
  sessionAdapters.set(sessionId, adapterName);
}
