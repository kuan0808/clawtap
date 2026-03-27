// server/adapters/gemini/gemini-tmux-adapter.ts
//
// Session lifecycle management for Gemini CLI sessions running in tmux.
//
// Key difference from Codex's CodexTmuxAdapter:
// - Gemini has 6 hooks: SessionStart, SessionEnd, BeforeTool, AfterTool, BeforeAgent, AfterAgent
// - Tool lifecycle comes from hooks (BeforeTool/AfterTool), not just JSON watching
// - Uses JsonWatcher (full JSON reparse) instead of JsonlWatcher (append-only)
// - Permission mode uses Ctrl+Y for default <-> yolo toggle

import { EventEmitter } from 'events';
import { tmuxManager } from '../shared/tmux-manager.js';
import { GeminiPaneMonitor } from './pane-monitor.js';
import { JsonWatcher } from '../../stores/json-watcher.js';
import { GeminiTranscriptParser } from './transcript-parser.js';
import type { GeminiSessionMessage } from '../../stores/json-watcher.js';
import type { PermissionBehavior, QueryOptions } from '../../types/messages.js';
import type { ReconnectState } from '../../types/adapter.js';
import type { ActiveSessionInfo } from '../interface.js';
import { isLargeContent } from '../interface.js';
import { PermissionManager } from '../../permission-manager.js';
import { findActiveSession } from '../shared/find-active-session.js';
import { readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Hook body payload from the Gemini CLI */
export interface GeminiHookBody {
  session_id?: string;
  cwd?: string;
  model?: string;
  hook_event_name?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

/** Internal session state for a managed tmux session */
export interface GeminiSessionState {
  windowId: string;
  monitor: GeminiPaneMonitor | null;
  watcher: JsonWatcher | null;
  parser: GeminiTranscriptParser | null;
  cwd: string;
  cliSessionId: string;
  transcriptPath: string | null;
  permissionMode: string;
  lastActivity: number;
  firstPrompt: string | null;
  isProcessing: boolean;
  _promptSenderClientId: string | null;
  _watcherPending: boolean;
  _matchRetryTimer: ReturnType<typeof setTimeout> | null;
}

/** Hook body with timestamp for age-based cleanup */
type PendingHookBody = GeminiHookBody & { _storedAt: number };

/** Resolved session context from _resolveAndTouch */
interface ResolvedContext {
  sessionId: string;
  session: GeminiSessionState | undefined;
}

// ---------------------------------------------------------------------------
// GeminiTmuxAdapter
// ---------------------------------------------------------------------------

/**
 * GeminiTmuxAdapter — manages Gemini CLI sessions via tmux.
 *
 * Three channels provide events to the SessionManager:
 * 1. HTTP Hooks (lifecycle): SessionStart, SessionEnd, BeforeTool, AfterTool, BeforeAgent, AfterAgent
 * 2. JSON Watcher (messages): new-messages, thinking, status-update
 * 3. PaneMonitor (ephemeral): streaming-text, thinking
 *
 * Events emitted:
 *   streaming-text(sessionId, text)
 *   thinking(sessionId, { text, detail })
 *   tool-start(sessionId, { toolId, toolName, input })
 *   tool-done(sessionId, { toolId, toolName, result })
 *   new-messages(sessionId, messages[])
 *   session-idle(sessionId)
 *   processing-started(sessionId)
 *   status-update(sessionId, { model, tokens })
 *   session-error(sessionId, { errorType, errorDetails })
 *   session-ended(sessionId)
 *   session-rekeyed(oldKey, newKey)
 */
export class GeminiTmuxAdapter extends EventEmitter {
  // sessionId -> session state
  sessions: Map<string, GeminiSessionState>;
  private _permissions: PermissionManager;
  private _clientChecker: ((sessionId: string) => boolean) | null;
  private _cleanupInterval: ReturnType<typeof setInterval> | null;
  private _pendingHookBodies: Map<string, PendingHookBody> = new Map();
  // Track tool IDs from BeforeTool → AfterTool so events correlate
  private _activeToolId: string | null = null;

  constructor() {
    super();
    this.sessions = new Map();
    this._permissions = new PermissionManager();
    this._clientChecker = null;
    this._cleanupInterval = null;
    this._startSessionCleanup();
  }

  /** Set a function that checks if WS clients are connected for a session */
  setClientChecker(fn: (sessionId: string) => boolean): void {
    this._clientChecker = fn;
  }

  // === Session Lifecycle ===

  async startSession(cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string; pendingRekey?: boolean }> {
    const mode = options.permissionMode || 'default';
    const parts = ['gemini', '--approval-mode', this._toCliApprovalMode(mode)];
    if (options.model) parts.push('-m', options.model);

    const tempName = `gemini-${Date.now()}`;
    console.log(`[gemini-tmux] startSession: tempName=${tempName} cwd=${cwd} mode=${mode}`);
    const windowId = await tmuxManager.createWindow(tempName, cwd, parts.join(' '));

    // Register session BEFORE _waitForReady — SessionStart hook fires during
    // CLI startup and needs to find this session in the Map for matching.
    this.sessions.set(tempName, this._createSession(windowId, cwd, '', mode));

    await this._waitForReady(windowId);

    // After _waitForReady, SessionStart hook may have fired and rekeyed
    // the session from tempName to the real CLI UUID. Return the current key.
    let finalId = tempName;
    if (!this.sessions.has(tempName)) {
      const rekeyed = [...this.sessions.entries()].find(([, s]) => s.windowId === windowId)?.[0];
      if (rekeyed) {
        finalId = rekeyed;
        console.log(`[gemini-tmux] startSession: rekeyed ${tempName} → ${rekeyed}`);
      } else {
        console.warn(`[gemini-tmux] Session ${tempName} vanished during startup (windowId=${windowId})`);
      }
    }

    console.log(`[gemini-tmux] startSession: finalId=${finalId} pendingRekey=${finalId === tempName}`);
    this._startMonitor(finalId, windowId);

    return { sessionId: finalId, pendingRekey: finalId === tempName };
  }

  async resumeSession(sessionId: string, cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    const session = this.sessions.get(sessionId);
    const geminiUuid = session?.cliSessionId || sessionId;
    const mode = options.permissionMode || session?.permissionMode || 'default';

    // Check if tmux window still alive
    if (session) {
      const windows = await tmuxManager.listWindows();
      if (windows.some(w => w.id === session.windowId)) {
        if (!session.monitor) this._startMonitor(sessionId, session.windowId);
        session.permissionMode = mode;
        session.lastActivity = Date.now();
        return { sessionId };
      }
      // Window gone — teardown old
      this._teardownSession(session);
    }

    const parts = ['gemini', '--resume', geminiUuid, '--approval-mode', this._toCliApprovalMode(mode)];
    if (options.model) parts.push('-m', options.model);

    const newSessionId = geminiUuid;
    const windowId = await tmuxManager.createWindow(geminiUuid, cwd, parts.join(' '));

    // Register before _waitForReady — same pattern as startSession
    if (session) {
      if (sessionId !== newSessionId) this.sessions.delete(sessionId);
      session.windowId = windowId;
      session.lastActivity = Date.now();
      session.permissionMode = mode;
      session._watcherPending = true;
      session.transcriptPath = null;
      session.watcher = null;
      session.parser = null;
      this.sessions.set(newSessionId, session);
    } else {
      this.sessions.set(newSessionId, this._createSession(windowId, cwd, geminiUuid, mode));
    }

    await this._waitForReady(windowId);

    this._startMonitor(newSessionId, windowId);
    return { sessionId: newSessionId };
  }

  /**
   * Toggle permission mode via Ctrl+Y.
   * Only supports binary toggle: default <-> yolo at runtime.
   * auto_edit and plan are only settable at session launch.
   */
  async switchPermissionMode(sessionId: string, targetMode: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // Ctrl+Y toggles default <-> yolo
    await tmuxManager.sendControl(session.windowId, 'C-y');
    session.permissionMode = targetMode;
    return true;
  }

  async sendMessage(sessionId: string, text: string, options: QueryOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session._promptSenderClientId = options.clientId || null;
    session.isProcessing = true;

    // Restart pane monitor if it was stopped
    if (!session.monitor) {
      this._startMonitor(sessionId, session.windowId);
    }

    if (isLargeContent(text)) {
      const singleLine = text.replace(/\n/g, '\\n');

      const markerMatch = singleLine.match(/^\[CLAWTAP_REF:[^\]]+\]/);
      if (markerMatch) {
        const marker = markerMatch[0];
        const rest = singleLine.substring(marker.length);
        await tmuxManager.sendKeys(session.windowId, marker, false);
        await new Promise<void>(r => setTimeout(r, 200));
        if (rest) {
          await tmuxManager.pasteBuffer(session.windowId, rest, false);
        }
      } else {
        await tmuxManager.pasteBuffer(session.windowId, singleLine, false);
      }
      await new Promise<void>(r => setTimeout(r, 300));
      await tmuxManager.sendControl(session.windowId, 'Enter');
    } else {
      await tmuxManager.sendKeys(session.windowId, text, false);
      await new Promise<void>(r => setTimeout(r, 200));
      await tmuxManager.sendControl(session.windowId, 'Enter');
    }

    // If there are pending hook bodies waiting for marker matching, try now
    if (this._pendingHookBodies.size > 0 && session._watcherPending) {
      this._tryMatchPending(sessionId);
    }
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await tmuxManager.sendKeys(session.windowId, `/model ${model}`, false);
    await new Promise<void>(r => setTimeout(r, 200));
    await tmuxManager.sendControl(session.windowId, 'Enter');
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await tmuxManager.sendControl(session.windowId, 'C-c');
    session.isProcessing = false;
    if (session.monitor) {
      session.monitor.stop();
      session.monitor = null;
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._teardownSession(session);
    await tmuxManager.killWindow(session.windowId);
    this.sessions.delete(sessionId);
    this.emit('session-ended', sessionId);
  }

  // === Hook Handlers ===

  /**
   * Handle the SessionStart hook from Gemini CLI.
   *
   * This is the moment we learn the transcript_path and can start the JSON watcher.
   * It may also be the first time we see the Gemini session UUID for sessions started via startSession().
   */
  handleSessionStart(body: GeminiHookBody): void {
    const geminiUuid = body.session_id;
    if (!geminiUuid) return;

    // 1. Already managed (resume, or session with known UUID)
    if (this.sessions.has(geminiUuid)) {
      this._applySessionStartBody(geminiUuid, body);
      return;
    }

    // 2. Find pending sessions (_watcherPending === true)
    const pending = [...this.sessions.entries()].filter(([, s]) => s._watcherPending);
    if (pending.length === 0) return; // Not our session

    // 3. Exactly 1 pending -> direct match (no marker needed)
    if (pending.length === 1) {
      const [tempKey] = pending[0];
      console.log(`[gemini-tmux] Direct match: ${tempKey} -> ${geminiUuid}`);
      this._rekeyAndRename(tempKey, geminiUuid);
      this._applySessionStartBody(geminiUuid, body);
      return;
    }

    // 4. Multiple pending -> store, wait for sendMessage to disambiguate via marker
    this._pendingHookBodies.set(geminiUuid, { ...body, _storedAt: Date.now() });
  }

  /**
   * Handle the BeforeTool hook from Gemini CLI.
   * Emits tool-start for the tool about to run.
   */
  handleBeforeTool(body: GeminiHookBody): void {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId } = ctx;
    const toolId = body.tool_use_id || `${body.tool_name}-${Date.now()}`;
    this._activeToolId = toolId;
    this.emit('tool-start', sessionId, {
      toolId,
      toolName: body.tool_name || 'unknown',
      input: body.tool_input || {},
    });
  }

  /**
   * Handle the AfterTool hook from Gemini CLI.
   * Emits tool-done for the tool that just finished.
   */
  handleAfterTool(body: GeminiHookBody): void {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId } = ctx;
    // Use the toolId from BeforeTool if available, ensuring start/done events correlate
    const toolId = this._activeToolId || body.tool_use_id || `${body.tool_name}-${Date.now()}`;
    this._activeToolId = null;

    let resultStr = '';
    if (body.tool_response !== undefined && body.tool_response !== null) {
      resultStr = typeof body.tool_response === 'string'
        ? body.tool_response
        : JSON.stringify(body.tool_response);
    }

    this.emit('tool-done', sessionId, {
      toolId,
      toolName: body.tool_name || 'unknown',
      result: resultStr,
    });
  }

  /**
   * Handle the BeforeAgent hook from Gemini CLI.
   * Signals that the agent is starting to process.
   */
  handleBeforeAgent(body: GeminiHookBody): void {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId, session } = ctx;
    if (session) {
      session.isProcessing = true;
      if (!session.monitor && session.windowId) {
        this._startMonitor(sessionId, session.windowId);
      }
    }

    this.emit('processing-started', sessionId);
  }

  /**
   * Handle the AfterAgent hook from Gemini CLI.
   * Signals that the agent has finished processing (turn complete).
   */
  handleAfterAgent(body: GeminiHookBody): void {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId, session } = ctx;
    if (session) {
      session.isProcessing = false;
      if (session.monitor) {
        session.monitor.stop();
        session.monitor = null;
      }
      // Flush JSON watcher to get final entries
      if (session.watcher) {
        session.watcher.pollNow();
      }
    }

    this.emit('session-idle', sessionId);
    this._permissions.dismissAll(sessionId);
  }

  /**
   * Handle the SessionEnd hook from Gemini CLI.
   * Cleans up the session.
   */
  handleSessionEnd(body: GeminiHookBody): void {
    const sessionId = body.session_id;
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    this._teardownSession(session);
    this.sessions.delete(sessionId);
    this.emit('session-ended', sessionId);
  }

  // === JSON Watcher ===

  /**
   * Process new JSON messages through the transcript parser and emit events.
   */
  private _processWatcherMessages(sessionId: string, rawMessages: GeminiSessionMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (!session?.parser) return;

    const result = session.parser.parse(rawMessages);

    // Emit errors as session-error events
    for (const errText of result.errors) {
      this.emit('session-error', sessionId, {
        errorType: 'gemini_error',
        errorDetails: errText,
      });
    }

    // Single pass: extract thoughts + status from gemini/info messages
    for (const msg of rawMessages) {
      if (msg.type === 'gemini') {
        const thoughts = GeminiTranscriptParser.extractThoughts(msg);
        for (const thought of thoughts) {
          this.emit('thinking', sessionId, {
            text: thought.subject || 'Thinking...',
            detail: thought.description || null,
          });
        }
        const status = GeminiTranscriptParser.extractStatus(msg);
        if (status) this.emit('status-update', sessionId, status);
      } else if (msg.type === 'info') {
        const status = GeminiTranscriptParser.extractStatus(msg);
        if (status) this.emit('status-update', sessionId, status);
      }
    }

    // Emit messages
    if (result.messages.length > 0) {
      // Capture first user prompt for active sessions list
      if (!session.firstPrompt) {
        const userMsg = result.messages.find(m => m.role === 'user');
        if (userMsg) {
          const text = userMsg.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          if (text) {
            const stripped = text.replace(/^(?:\[CLAWTAP_REF:[^\]]+\]|\d+\])(?:\\n|\n)?/, '');
            session.firstPrompt = stripped.substring(0, 200);
          }
        }
      }

      // Tag user messages with sender's client ID so only the sender skips (dedup)
      for (const msg of result.messages) {
        if (msg.role === 'user' && session._promptSenderClientId) {
          msg.senderClientId = session._promptSenderClientId;
          session._promptSenderClientId = null;
        }
      }

      this.emit('new-messages', sessionId, result.messages);
    }
  }

  // === Query Methods ===

  getSession(sessionId: string): GeminiSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = [];
    for (const [sessionId, session] of this.sessions) {
      result.push({
        sessionId,
        cwd: session.cwd,
        adapter: 'gemini',
        permissionMode: session.permissionMode,
        lastActivity: session.lastActivity || null,
        hasClients: this._clientChecker ? this._clientChecker(sessionId) : false,
        hasDesktop: !!(session.lastActivity && (Date.now() - session.lastActivity < 120_000)),
        isNonInteractive: false,
        firstPrompt: session.firstPrompt || null,
      });
    }
    return result;
  }

  async hasActiveWindow(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const windows = await tmuxManager.listWindows();
    return windows.some(w => w.id === session.windowId);
  }

  isProcessing(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!(session?.isProcessing);
  }

  /** Force an immediate JSON poll for a session */
  flushMessages(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) session.watcher.pollNow();
  }

  /** Advance watcher past current file position without emitting messages */
  syncWatcherPosition(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) session.watcher.markCurrentPosition();
  }

  /** Get pending state for reconnecting clients (tools, permissions, questions) */
  getReconnectState(sessionId: string): ReconnectState {
    const state: ReconnectState = { tools: {} as Record<string, import('../../types/messages.js').ToolStatus>, pendingRequests: [] };

    for (const perm of this._permissions.getPendingForSession(sessionId)) {
      state.pendingRequests.push({
        type: 'permission',
        requestId: perm.requestId,
        toolName: perm.toolName,
        input: perm.input,
      });
    }
    for (const q of this._permissions.getQuestionsForSession(sessionId)) {
      state.pendingRequests.push({
        type: 'question',
        requestId: q.requestId,
        toolName: 'AskUserQuestion',
        input: q.originalInput,
      });
    }

    return state;
  }

  // === Permission Methods ===

  respondPermission(requestId: string, behavior: PermissionBehavior): void {
    const pending = this._permissions.resolvePermission(requestId);
    if (!pending) return;

    const session = this.sessions.get(pending.sessionId);
    if (!session) return;

    if (behavior === 'allow' || behavior === 'allow_session') {
      tmuxManager.sendKeys(session.windowId, 'y', true).catch(() => {});
    } else {
      tmuxManager.sendKeys(session.windowId, 'n', true).catch(() => {});
    }
  }

  async respondQuestion(requestId: string, answer: string): Promise<void> {
    const pending = this._permissions.resolveQuestion(requestId);
    if (!pending) return;

    const session = this.sessions.get(pending.sessionId);
    if (!session) return;

    await tmuxManager.sendKeys(session.windowId, answer, true);
  }

  respondInteractivePrompt(requestId: string, selectedOption?: string, textValue?: string): void {
    const pending = this._permissions.resolvePermission(requestId)
      || this._permissions.resolveQuestion(requestId);
    // For pane-monitor-detected prompts, there may be no pending entry — find session from active sessions
    const sessionId = pending?.sessionId || findActiveSession(this.sessions);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (selectedOption != null) {
      const index = parseInt(selectedOption);
      if (!isNaN(index)) {
        // Gemini numbered options: navigate Down × index, then Enter
        this._selectNumberedOption(session.windowId, index).catch(() => {});
      }
    }
    if (textValue != null) {
      tmuxManager.sendKeys(session.windowId, textValue, true).catch(() => {});
    }
  }

  /** Release all pending requests for a session */
  releaseAllPending(sessionId: string): void {
    this._permissions.dismissAll(sessionId);
  }

  resolveAllPendingAs(sessionId: string, behavior: PermissionBehavior | string): void {
    const resolvedIds = this._permissions.resolveAllAs(sessionId, behavior as string);
    if (behavior === 'allow') {
      const session = this.sessions.get(sessionId);
      if (session) {
        for (const _reqId of resolvedIds) {
          tmuxManager.sendKeys(session.windowId, 'y', true).catch(() => {});
        }
      }
    }
  }

  private async _selectNumberedOption(windowId: string, targetIndex: number): Promise<void> {
    for (let i = 0; i < targetIndex; i++) {
      await tmuxManager.sendControl(windowId, 'Down');
      await new Promise<void>(r => setTimeout(r, 50));
    }
    await tmuxManager.sendControl(windowId, 'Enter');
  }

  // === Cleanup ===

  async destroy(): Promise<void> {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    for (const [, session] of this.sessions) {
      this._teardownSession(session);
    }
    this.sessions.clear();
    await tmuxManager.killSession();
  }

  // === Internal Helpers ===

  /** Map permission mode string to Gemini CLI --approval-mode value */
  private _toCliApprovalMode(mode: string): string {
    switch (mode) {
      case 'yolo': return 'yolo';
      case 'auto_edit': return 'auto_edit';
      case 'plan': return 'plan';
      default: return 'default';
    }
  }

  /** Resolve hook body to internal session, touch lastActivity */
  private _resolveAndTouch(body: GeminiHookBody): ResolvedContext | null {
    const sessionId = body.session_id;
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastActivity = Date.now();
    return { sessionId, session };
  }

  private _createSession(
    windowId: string,
    cwd: string,
    cliSessionId: string,
    permissionMode: string,
  ): GeminiSessionState {
    return {
      windowId,
      monitor: null,
      watcher: null,
      parser: null,
      cwd,
      cliSessionId,
      transcriptPath: null,
      permissionMode,
      lastActivity: Date.now(),
      firstPrompt: null,
      isProcessing: false,
      _promptSenderClientId: null,
      _watcherPending: true,
      _matchRetryTimer: null,
    };
  }

  /**
   * Wait for Gemini CLI to be ready.
   * Polls tmux pane content until a prompt indicator appears.
   */
  private async _waitForReady(windowId: string, timeoutMs: number = 60000): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      try {
        const content = await tmuxManager.capturePane(windowId);
        const lines = content.split('\n');
        // Gemini shows > (default), * (yolo), or ❯ as prompt indicator
        const hasPrompt = lines.some(l => /^\s*[>*❯]/.test(l));

        if (hasPrompt) {
          console.log(`[gemini-tmux] CLI ready for ${windowId} in ${Date.now() - start}ms`);
          await new Promise<void>(r => setTimeout(r, 300));
          return;
        }

        // Privacy Notice or Terms of Service popup — dismiss with Esc
        if (!hasPrompt && (content.includes('Privacy Notice') ||
            (content.includes('Terms of Service') && !content.includes('trust the files')))) {
          console.log('[gemini-tmux] Privacy/ToS notice detected, dismissing');
          await tmuxManager.sendControl(windowId, 'Escape');
          await new Promise<void>(r => setTimeout(r, 500));
          continue;
        }

        // Multi-folder trust dialog ("trust the following folders")
        if (!hasPrompt && content.includes('trust the following folders')) {
          console.log('[gemini-tmux] Multi-folder trust detected, accepting');
          await tmuxManager.sendControl(windowId, 'Enter');
          await new Promise<void>(r => setTimeout(r, 1000));
          continue;
        }

        // IDE integration nudge — decline
        if (!hasPrompt && content.includes('Do you want to connect') && content.includes('Gemini CLI')) {
          console.log('[gemini-tmux] IDE nudge detected, declining');
          await tmuxManager.sendControl(windowId, 'Down');
          await new Promise<void>(r => setTimeout(r, 50));
          await tmuxManager.sendControl(windowId, 'Enter');
          await new Promise<void>(r => setTimeout(r, 500));
          continue;
        }

        // Auto-accept folder trust prompt (Gemini asks on first use in a directory).
        // Only runs when prompt is NOT yet visible.
        if (content.includes('trust the files') && content.includes('Trust folder')) {
          const parentMatch = content.match(/(\d+)\.\s+Trust parent folder/);
          if (parentMatch) {
            const targetOption = parseInt(parentMatch[1]);
            console.log(`[gemini-tmux] Folder trust prompt detected, selecting option ${targetOption} (Trust parent folder)`);
            for (let i = 1; i < targetOption; i++) {
              await tmuxManager.sendControl(windowId, 'Down');
              await new Promise<void>(r => setTimeout(r, 50));
            }
          } else {
            console.log(`[gemini-tmux] Folder trust prompt detected, accepting default (Trust folder)`);
          }
          await tmuxManager.sendControl(windowId, 'Enter');
          await new Promise<void>(r => setTimeout(r, 1000));
          continue;
        }

        if (attempt <= 3 || attempt % 5 === 0) {
          const lineCount = lines.filter(l => l.trim()).length;
          console.log(`[gemini-tmux] waitForReady #${attempt}: window=${windowId} prompt=${hasPrompt} lines=${lineCount}`);
          if (lineCount > 0) {
            const nonEmpty = lines.filter(l => l.trim());
            console.log(`[gemini-tmux] waitForReady content: first="${nonEmpty[0]?.substring(0, 60)}" last="${nonEmpty[nonEmpty.length - 1]?.substring(0, 60)}"`);
          }
        }
      } catch (err) {
        console.log(`[gemini-tmux] waitForReady #${attempt}: ERROR ${(err as Error).message}`);
      }
      await new Promise<void>(r => setTimeout(r, 500));
    }
    console.warn(`[gemini-tmux] Timed out waiting for CLI ready on ${windowId}`);
  }

  /** Apply hook body state and start watcher — shared by all handleSessionStart branches */
  private _applySessionStartBody(sessionId: string, body: GeminiHookBody): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.cliSessionId) session.cliSessionId = body.session_id || '';
    if (body.cwd) session.cwd = body.cwd;
    if (body.model) {
      // Emit initial model as status update
      this.emit('status-update', sessionId, { model: body.model, tokens: null });
    }
    session.lastActivity = Date.now();
    if (body.transcript_path && !session.transcriptPath) {
      session.transcriptPath = body.transcript_path;
    }

    // Start JSON watcher if we have a transcript path and watcher isn't already running
    if (session.transcriptPath && !session.watcher) {
      const skipExisting = session.isProcessing !== false;
      this._startWatcher(sessionId, session, skipExisting);
    }
    session._watcherPending = false;
  }

  /**
   * Called after sendMessage when _pendingHookBodies has entries.
   * Reads each pending hook body's transcript_path to find the CLAWTAP_REF marker.
   */
  private async _tryMatchPending(tempKey: string): Promise<void> {
    if (await this._scanPendingForMarker(tempKey)) return;

    // Marker not found yet — Gemini may still be writing. Retry once after 2s.
    const session = this.sessions.get(tempKey);
    if (!session) return;
    if (session._matchRetryTimer) clearTimeout(session._matchRetryTimer);
    session._matchRetryTimer = setTimeout(async () => {
      const s = this.sessions.get(tempKey);
      if (!s || !s._watcherPending || !this._pendingHookBodies.size) return;
      await this._scanPendingForMarker(tempKey);
    }, 2000);
  }

  /** Scan _pendingHookBodies for a transcript containing CLAWTAP_REF:{tempKey}. */
  private async _scanPendingForMarker(tempKey: string): Promise<boolean> {
    for (const [uuid, body] of this._pendingHookBodies) {
      if (!body.transcript_path) continue;
      try {
        const content = await readFile(body.transcript_path, 'utf8');
        if (!content.includes(`CLAWTAP_REF:${tempKey}`)) continue;
        console.log(`[gemini-tmux] Marker match: ${tempKey} -> ${uuid}`);
        this._pendingHookBodies.delete(uuid);
        this._rekeyAndRename(tempKey, uuid);
        this._applySessionStartBody(uuid, body);
        return true;
      } catch { continue; }
    }
    return false;
  }

  /**
   * Re-key a session from tempKey to the real CLI UUID and rename the tmux window.
   */
  private _rekeyAndRename(tempKey: string, cliUuid: string): void {
    const session = this.sessions.get(tempKey);
    if (!session) return;
    session.cliSessionId = cliUuid;
    session._watcherPending = false;
    this.sessions.delete(tempKey);
    this.sessions.set(cliUuid, session);
    tmuxManager.renameWindow(session.windowId, cliUuid).catch(() => {});
    if (session.monitor) {
      (session.monitor as any).sessionId = cliUuid;
    }
    // Notify session-manager to re-register clients under the new key
    this.emit('session-rekeyed', tempKey, cliUuid);
  }

  private _startMonitor(sessionId: string, windowId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.monitor) {
      session.monitor.stop();
    }

    const monitor = new GeminiPaneMonitor(sessionId, windowId, tmuxManager, this);
    monitor.start();
    session.monitor = monitor;
  }

  private _startWatcher(sessionId: string, session: GeminiSessionState, skipExisting = true): void {
    if (!session.transcriptPath) return;
    if (session.watcher) return;

    const parser = new GeminiTranscriptParser();
    const watcher = new JsonWatcher(session.transcriptPath);

    watcher.onNewMessages((messages) => {
      this._processWatcherMessages(sessionId, messages);
    });

    watcher.start({ skipExisting, fallbackIntervalMs: 1000 });
    session.watcher = watcher;
    session.parser = parser;
    session._watcherPending = false;
  }

  private _teardownSession(session: GeminiSessionState): void {
    if (session.monitor) {
      session.monitor.stop();
      session.monitor = null;
    }
    if (session.watcher) {
      session.watcher.stop();
      session.watcher = null;
      session.parser = null;
    }
    if (session._matchRetryTimer) {
      clearTimeout(session._matchRetryTimer);
      session._matchRetryTimer = null;
    }
  }

  private _startSessionCleanup(): void {
    this._cleanupInterval = setInterval(async () => {
      const windows = await tmuxManager.listWindows();
      const liveWindowIds = new Set(windows.map(w => w.id));

      for (const [sessionId, session] of this.sessions) {
        if (session.windowId && !liveWindowIds.has(session.windowId)) {
          console.log(`[gemini-tmux] Stale session ${sessionId} — tmux window gone, cleaning up`);
          this._teardownSession(session);
          this.sessions.delete(sessionId);
          this.emit('session-ended', sessionId);
        }
      }

      // Cap at 10 managed sessions
      if (this.sessions.size > 10) {
        const sorted = [...this.sessions.entries()]
          .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0));
        for (const [id] of sorted.slice(10)) {
          const s = this.sessions.get(id);
          if (s) this._teardownSession(s);
          this.sessions.delete(id);
          this.emit('session-ended', id);
        }
      }

      // Clean up stale pending hook bodies (age-based sweep)
      for (const [uuid, body] of this._pendingHookBodies) {
        const age = Date.now() - body._storedAt;
        if (age > 60_000) this._pendingHookBodies.delete(uuid);
      }
    }, 60_000);
    this._cleanupInterval.unref();
  }
}
