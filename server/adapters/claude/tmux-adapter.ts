import { EventEmitter } from 'events';
import { tmuxManager } from '../shared/tmux-manager.js';
import type { TmuxWindow } from '../shared/tmux-manager.js';
import { PaneMonitor } from './pane-monitor.js';
import { JsonlWatcher } from '../../stores/jsonl-watcher.js';
import { TranscriptParser } from './transcript-parser.js';
import type { ParsedMessage } from './transcript-parser.js';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import { PROJECTS_DIR, encodeDirName, parseSessionHeader } from './jsonl-store.js';
import { extractText } from './message-utils.js';
import type { JsonlEntry } from './message-utils.js';
import type { PermissionBehavior, QueryOptions } from '../../types/messages.js';
import type { ReconnectState } from '../../types/adapter.js';
import type { ActiveSessionInfo } from '../interface.js';
import { isLargeContent } from '../interface.js';
import { PermissionManager } from '../../permission-manager.js';
import { PLAN_OPTION } from '../../ws-types.js';

const MODE_CYCLE: string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
/** Internal session state for a managed tmux session */
export interface SessionState {
  windowId: string;
  monitor: PaneMonitor | null;
  watcher: JsonlWatcher | null;
  parser: TranscriptParser | null;
  cwd: string;
  cliSessionId: string;
  permissionMode: string;
  lastActivity: number;
  firstPrompt: string | null;
  isProcessing: boolean;
  isNonInteractive: boolean;
  _interactiveChecked: boolean;
  _promptSenderClientId: string | null;
  _modeTransitionDeadline: number;
  _watcherPending: boolean;
}

/** Hook body payload from Claude CLI */
export interface HookBody {
  session_id?: string;
  permission_mode?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: string;
  error_details?: string;
  is_interrupt?: boolean;
  [key: string]: unknown;
}

/** Resolved session context from _resolveAndTouch */
interface ResolvedContext {
  sessionId: string;
  session: SessionState | undefined;
}

/**
 * TmuxAdapter — manages Claude Code sessions via tmux.
 *
 * Three channels provide events to the SessionManager:
 * 1. HTTP Hooks (structured): tool-start, tool-done, session-idle, permission-request
 * 2. JSONL Watcher (messages): new-messages (single source of truth)
 * 3. PaneMonitor (ephemeral): streaming-text, thinking
 *
 * Events emitted:
 *   streaming-text(sessionId, text)
 *   thinking(sessionId, { text, detail })
 *   tool-start(sessionId, { toolId, toolName, input })
 *   tool-done(sessionId, { toolId, toolName, result })
 *   new-messages(sessionId, messages[])
 *   session-idle(sessionId)
 *   session-error(sessionId, { errorType, errorDetails })
 *   permission-request(sessionId, { requestId, toolName, input })
 *   ask-question(sessionId, { requestId, toolName, input })
 *   mode-changed(sessionId, mode)
 *   session-ended(sessionId)
 *   compacting(sessionId)
 *   compact-done(sessionId)
 *   processing-started(sessionId)
 */
export class TmuxAdapter extends EventEmitter {
  // sessionId (CLI UUID) -> { windowId, monitor, watcher, parser, cwd, cliSessionId, permissionMode }
  sessions: Map<string, SessionState>;
  // Centralized pending permissions/questions manager
  private _permissions: PermissionManager;
  // Set by SessionManager to check if WS clients are connected
  private _clientChecker: ((sessionId: string) => boolean) | null;
  private _cleanupInterval: ReturnType<typeof setInterval> | null;

  // CLI permission prompt option layout (Claude CLI v2.x):
  //   0: "Yes"
  //   1: "Yes, allow all edits during this session (shift+tab)"
  //   2: "No"
  static PERMISSION_DENY_INDEX: number = 2;

  constructor() {
    super();
    this.sessions = new Map();
    this._permissions = new PermissionManager();
    this._clientChecker = null;
    this._cleanupInterval = null;
    this._startSessionCleanup();
  }

  /** Set a function that checks if WS clients are connected for a session */
  setClientChecker(fn: (sessionId: string) => boolean): void { this._clientChecker = fn; }

  // === Session Lifecycle ===

  async startSession(cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    // Generate UUID upfront — no guessing needed
    const cliSessionId = crypto.randomUUID();

    const mode = options.permissionMode || 'default';
    const parts = ['claude', '--session-id', cliSessionId];
    // Always start with bypass so all 4 modes are reachable mid-session via Shift+Tab
    parts.push('--dangerously-skip-permissions');
    if (options.model) parts.push('--model', `'${options.model}'`);
    if (options.effort) parts.push('--effort', options.effort);

    const sessionId = cliSessionId;
    const windowId = await tmuxManager.createWindow(sessionId, cwd, parts.join(' '));

    // Register session BEFORE _waitForReady — SessionStart hook fires during the wait,
    // and needs the session in the Map to avoid creating a duplicate session/watcher.
    this.sessions.set(sessionId, this._createSession(windowId, cwd, cliSessionId, mode));

    await this._waitForReady(windowId);

    this._startMonitor(sessionId, windowId);
    this._ensureWatcher(sessionId);

    // Switch to user's desired mode (if not already bypassPermissions)
    if (mode && mode !== 'bypassPermissions') {
      await this.switchPermissionMode(sessionId, mode);
    }

    return { sessionId };
  }

  async attachSession(sessionId: string, cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(sessionId);

    // If already attached with a watcher, don't recreate
    if (existing?.watcher) {
      if (!existing.monitor) this._startMonitor(sessionId, existing.windowId);
      if (options.permissionMode) existing.permissionMode = options.permissionMode;
      return { sessionId };
    }

    const windowId = await this._findWindowForSession(sessionId);
    if (!windowId) throw new Error(`No tmux window found for session ${sessionId}`);

    // Defensive: if another session already manages this tmux window,
    // redirect to it instead of creating a duplicate entry.
    // Each tmux window runs exactly one Claude CLI — same window = same session.
    if (!existing) {
      for (const [existingId, existingSession] of this.sessions) {
        if (existingSession.windowId === windowId) {
          if (!existingSession.monitor) this._startMonitor(existingId, windowId);
          return { sessionId: existingId };
        }
      }
    }

    // Preserve existing watcher/parser if session entry exists
    if (existing) {
      existing.windowId = windowId;
      existing.lastActivity = Date.now();
      if (options.permissionMode) existing.permissionMode = options.permissionMode;
      if (!existing.monitor) this._startMonitor(sessionId, windowId);
    } else {
      this.sessions.set(sessionId, this._createSession(windowId, cwd, sessionId, options.permissionMode || 'default'));
      this._startMonitor(sessionId, windowId);
    }

    await this._ensureWatcher(sessionId);
    return { sessionId };
  }

  async resumeSession(sessionId: string, cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    const mode = options.permissionMode || 'default';
    const windows = await tmuxManager.listWindows();

    // Extract CLI UUID before potentially deleting the session
    const existingSession = this.sessions.get(sessionId);
    const cliUuid = existingSession?.cliSessionId || sessionId;

    // Check if session already managed and tmux window still exists
    if (existingSession) {
      if (await this._windowExists(existingSession.windowId, windows)) {
        if (!existingSession.monitor) this._startMonitor(sessionId, existingSession.windowId);
        existingSession.permissionMode = mode;
        existingSession.lastActivity = Date.now();
        await this._ensureWatcher(sessionId);
        return { sessionId };
      }
      // Window gone — stop old watcher before replacing
      this._teardownSession(existingSession);
      this.sessions.delete(sessionId);
    }

    // Check for existing tmux window (e.g., started from Desktop)
    const existingWindowId = await this._findWindowForSession(cliUuid, windows);
    if (existingWindowId) {
      return this.attachSession(sessionId, cwd, options);
    }

    // No existing window — create new with --resume
    const modeFlag = '--dangerously-skip-permissions';
    let command = `claude ${modeFlag} --resume ${cliUuid}`;
    if (options.effort) command += ` --effort ${options.effort}`;
    const newSessionId = cliUuid;
    const windowId = await tmuxManager.createWindow(cliUuid, cwd || process.cwd(), command);

    // Register before _waitForReady (same pattern as startSession)
    this.sessions.set(newSessionId, this._createSession(windowId, cwd, cliUuid, mode));

    await this._waitForReady(windowId);

    this._startMonitor(newSessionId, windowId);
    await this._ensureWatcher(newSessionId);
    return { sessionId: newSessionId };
  }

  async sendMessage(sessionId: string, text: string, options: QueryOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session._promptSenderClientId = options.clientId || null;
    // Restart pane monitor if it was stopped (e.g., after turn-complete)
    if (!session.monitor) {
      this._startMonitor(sessionId, session.windowId);
    }
    if (isLargeContent(text)) {
      // Large/multiline content: use pasteBuffer for speed.
      // Claude CLI handles multiline input natively — no \n replacement needed.
      // pasteBuffer defaults sendEnter=true, so Enter is sent automatically.
      await tmuxManager.pasteBuffer(session.windowId, text);
    } else {
      await tmuxManager.sendKeys(session.windowId, text, true);
    }
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await tmuxManager.sendKeys(session.windowId, `/model ${model}`, true);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await tmuxManager.sendControl(session.windowId, 'C-c');
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._teardownSession(session);
    await tmuxManager.killWindow(session.windowId);
    this.sessions.delete(sessionId);
    this.emit('session-ended', sessionId);
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Force an immediate JSONL poll for a session */
  flushMessages(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) session.watcher.pollNow();
  }

  /** Advance watcher past current file position without emitting entries */
  syncWatcherPosition(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) session.watcher.markCurrentPosition();
  }

  /** Get pending state for reconnecting clients (tools, permissions, questions) */
  getReconnectState(sessionId: string): ReconnectState {
    const session = this.sessions.get(sessionId);
    const state: ReconnectState = { tools: {}, pendingRequests: [] };

    if (session?.parser) {
      const tools = session.parser.getPendingTools();
      if (tools.size > 0) {
        // PendingTool is a superset of ToolStatus — cast is safe for reconnect replay
        state.tools = Object.fromEntries(tools) as unknown as Record<string, import('../../types/messages.js').ToolStatus>;
      }
    }

    for (const perm of this._permissions.getPendingForSession(sessionId)) {
      state.pendingRequests.push({ type: 'permission', requestId: perm.requestId, toolName: perm.toolName, input: perm.input });
    }
    for (const q of this._permissions.getQuestionsForSession(sessionId)) {
      state.pendingRequests.push({ type: 'question', requestId: q.requestId, toolName: 'AskUserQuestion', input: q.originalInput });
    }
    return state;
  }

  async hasActiveWindow(sessionId: string): Promise<boolean> {
    const windows = await tmuxManager.listWindows();
    const session = this.sessions.get(sessionId);
    if (session) return this._windowExists(session.windowId, windows);

    // Check if a tmux window exists for this session
    return !!(await this._findWindowForSession(sessionId, windows));
  }

  // === Permission Mode ===

  setPermissionMode(sessionId: string, mode: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.permissionMode = mode;
    return true;
  }

  async switchPermissionMode(sessionId: string, targetMode: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const currentMode = session.permissionMode || 'default';
    if (currentMode === targetMode) return true;

    const currentIdx = MODE_CYCLE.indexOf(currentMode);
    const targetIdx = MODE_CYCLE.indexOf(targetMode);
    if (currentIdx < 0 || targetIdx < 0) return false;

    const presses = (targetIdx - currentIdx + MODE_CYCLE.length) % MODE_CYCLE.length;

    // Set target BEFORE sending keys — prevents syncPermissionMode
    // from overwriting with intermediate modes during the Shift+Tab transition
    session.permissionMode = targetMode;
    session._modeTransitionDeadline = Date.now() + presses * 200 + 500;

    for (let i = 0; i < presses; i++) {
      await tmuxManager.sendControl(session.windowId, 'BTab');
      await new Promise<void>(r => setTimeout(r, 150));
    }

    return true;
  }

  // Permission mode precedence (highest → lowest):
  // 1. switchPermissionMode() — user-initiated from ClawTap UI, sets target immediately
  // 2. syncPermissionMode() — CLI reports its mode via hook body (authoritative)
  // 3. Client localStorage — persists user preference across sessions

  /**
   * Sync permission mode from CLI hook body. Called by hook handlers
   * (via _resolveAndTouch) and by statusline handler to catch desktop
   * Shift+Tab changes that don't trigger tool-use hooks.
   */
  syncPermissionMode(sessionId: string, body: HookBody): void {
    if (!body.permission_mode) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Skip sync while ClawTap-initiated Shift+Tab mode transition is in flight
    if (session._modeTransitionDeadline && Date.now() < session._modeTransitionDeadline) return;
    const cliMode = body.permission_mode === 'dontAsk' ? 'bypassPermissions' : body.permission_mode;
    if (session.permissionMode !== cliMode) {
      session.permissionMode = cliMode;
      this.emit('mode-changed', sessionId, cliMode);
    }
  }

  // === Hook Handlers (called from Express endpoints) ===
  //
  // Common preamble extracted into _resolveAndTouch():
  //   resolve session from body.session_id → syncPermissionMode → update lastActivity
  // handleSessionEnd bypasses the helper (needs different teardown logic).

  /**
   * Resolve hook body to internal session, sync permission mode, touch lastActivity.
   * Returns { sessionId, session } or null if session cannot be resolved.
   */
  private _resolveAndTouch(body: HookBody): ResolvedContext | null {
    const sessionId = body.session_id;
    if (!sessionId || !this.sessions.has(sessionId)) return null;
    this.syncPermissionMode(sessionId, body);
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
    return { sessionId, session };
  }

  /** Shared by handlePostToolUse and handlePostToolUseFailure. */
  private _emitToolDone(sessionId: string, body: HookBody, result: unknown): void {
    this.emit('tool-done', sessionId, {
      toolId: body.tool_use_id,
      toolName: body.tool_name,
      input: body.tool_input,
      result,
    });
    this._permissions.dismissAll(sessionId);
  }

  /** Shared by handleStop and handleStopFailure. */
  private _endTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isProcessing = false;
      if (session.monitor) {
        session.monitor.stop();
        session.monitor = null;
      }
    }
    this.emit('session-idle', sessionId);
    this._permissions.dismissAll(sessionId);
  }

  async handlePreToolUse(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    // AskUserQuestion: emit for Mobile picker UI. CLI shows terminal prompt,
    // mobile answers via tmux send-keys.
    if (body.tool_name === 'AskUserQuestion') {
      const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this._permissions.addQuestion(requestId, ctx.sessionId, { originalInput: body.tool_input || {} });
      this.emit('ask-question', ctx.sessionId, {
        requestId,
        toolName: 'AskUserQuestion',
        input: body.tool_input,
      });
      return;
    }

    this.emit('tool-start', ctx.sessionId, {
      toolId: body.tool_use_id,
      toolName: body.tool_name,
      input: body.tool_input,
    });
  }

  async handlePostToolUse(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this._emitToolDone(ctx.sessionId, body, body.tool_response);
  }

  async handlePostToolUseFailure(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this._emitToolDone(ctx.sessionId, body, {
      content: body.error, is_error: true, is_interrupt: body.is_interrupt,
    });
  }

  async handleUserPromptSubmit(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId, session } = ctx;
    if (session) {
      session.isProcessing = true;
      this.emit('processing-started', sessionId);
      // Do NOT markCurrentPosition() here — other mobile clients need to see the user message via JSONL.
      // The sender deduplicates via senderClientId on the client side.
      if (!session.monitor) this._startMonitor(sessionId, session.windowId);
    }

    this._detectNonInteractive(sessionId);
  }

  async handleStop(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this._endTurn(ctx.sessionId);
  }

  async handleStopFailure(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this.emit('session-error', ctx.sessionId, {
      errorType: body.error,
      errorDetails: body.error_details,
    });
    this._endTurn(ctx.sessionId);
  }

  async handleSessionEnd(body: HookBody): Promise<void> {
    const sessionId = body.session_id;
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (session) {
      this._teardownSession(session);
      this.sessions.delete(sessionId);
    }

    this.emit('session-ended', sessionId);
  }

  async handlePreCompact(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this.emit('compacting', ctx.sessionId);
  }

  async handlePostCompact(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    this.emit('compact-done', ctx.sessionId);
  }

  /** Handle real-time session discovery when CLI starts (SessionStart hook). */
  async handleSessionStart(body: HookBody): Promise<void> {
    const cliUuid = body.session_id;
    if (!cliUuid) return;

    if (this.sessions.has(cliUuid)) {
      this.sessions.get(cliUuid)!.lastActivity = Date.now();
      return;
    }
    // Unknown UUID — not our session, ignore
  }

  /**
   * Fire-and-forget notification — no return value.
   * YOLO/Auto-edit: CLI handles auto-allow via Shift+Tab, skip mobile overlay.
   * Normal: emit permission-request for mobile overlay. User answers via
   * tmux send-keys ('y'/'n'), not via hook response.
   */
  async handlePermissionRequest(body: HookBody): Promise<void> {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;
    const { sessionId, session } = ctx;
    const mode = session?.permissionMode || 'default';

    // YOLO/Auto-edit: CLI already auto-allows via Shift+Tab — skip mobile overlay
    if (mode === 'bypassPermissions') return;
    if (mode === 'acceptEdits' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(body.tool_name!)) return;
    // Plan tools have their own approval UI (PlanMode card) — skip generic overlay.
    // AskUserQuestion is handled by PreToolUse (question overlay, not permission overlay).
    if (['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion'].includes(body.tool_name!)) return;

    // Normal mode: notify mobile to show permission overlay
    const requestId = crypto.randomUUID();
    // Store truncated input for reconnect replay — full payload already broadcast via emit below
    const inputSummary: Record<string, unknown> = body.tool_input ? Object.fromEntries(
      Object.entries(body.tool_input).map(([k, v]) => [k, typeof v === 'string' && v.length > 500 ? v.substring(0, 500) + '\u2026' : v])
    ) : {};
    this._permissions.addPermission(requestId, sessionId, { toolName: body.tool_name!, input: inputSummary });
    this.emit('permission-request', sessionId, {
      requestId,
      toolName: body.tool_name,
      input: body.tool_input,
    });
  }

  async respondPermission(requestId: string, behavior: PermissionBehavior): Promise<void> {
    const pending = this._permissions.resolvePermission(requestId);
    if (!pending) return;

    const session = this.sessions.get(pending.sessionId);
    if (!session) return;

    const optionIndex = behavior === 'allow' ? 0
      : behavior === 'allow_session' ? 1
      : TmuxAdapter.PERMISSION_DENY_INDEX;
    await this._selectOption(session.windowId, optionIndex);
  }

  /**
   * Release all pending requests for a session (e.g., when Mobile disconnects).
   * Just clears pending state — CLI prompt remains on terminal.
   */
  releaseAllPending(sessionId: string): void {
    this._permissions.dismissAll(sessionId);
  }

  resolveAllPendingAs(sessionId: string, behavior: PermissionBehavior | string): void {
    const resolvedIds = this._permissions.resolveAllAs(sessionId, behavior as string);
    if (behavior === 'allow') {
      const session = this.sessions.get(sessionId);
      if (session) {
        for (const _reqId of resolvedIds) {
          this._selectOption(session.windowId, 0).catch(() => {});
        }
      }
    }
  }

  async respondQuestion(requestId: string, answer: string): Promise<void> {
    const pending = this._permissions.resolveQuestion(requestId);
    if (!pending) return;

    const input = pending.originalInput || {};
    const questions = (input.questions as Array<{ options?: Array<{ label?: string; value?: string }> }>) || [];
    const options = questions[0]?.options || [];
    const optionIndex = options.findIndex(o => o.label === answer || o.value === answer);

    const session = this.sessions.get(pending.sessionId);
    if (!session) return;

    if (optionIndex >= 0) {
      // Matched a predefined option — select it directly
      await this._selectOption(session.windowId, optionIndex);
    } else {
      // Free-form answer — select "Type something" (at index options.length) then type answer
      await this._selectOption(session.windowId, options.length);
      await new Promise<void>(r => setTimeout(r, 200));
      await tmuxManager.sendKeys(session.windowId, answer, true);
    }
  }

  /**
   * Respond to the CLI's plan approval selector.
   * Options: 0=bypass (auto-accept edits), 1=manually approve, 2=text feedback
   */
  async respondPlan(sessionId: string, optionIndex: number, text?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || optionIndex < 0 || optionIndex > PLAN_OPTION.TEXT_FEEDBACK) return;
    if (optionIndex === PLAN_OPTION.TEXT_FEEDBACK && text) {
      await this._selectOption(session.windowId, PLAN_OPTION.TEXT_FEEDBACK);
      await new Promise<void>(r => setTimeout(r, 200));
      await tmuxManager.sendKeys(session.windowId, text, true);
    } else {
      await this._selectOption(session.windowId, optionIndex);
    }
  }

  /**
   * Navigate a CLI interactive selector by pressing Down `index` times, then Enter.
   * Cursor starts on option 0 (first item), so index=0 just presses Enter.
   */
  private async _selectOption(windowId: string, index: number): Promise<void> {
    for (let i = 0; i < index; i++) {
      await tmuxManager.sendControl(windowId, 'Down');
      await new Promise<void>(r => setTimeout(r, 100));
    }
    await tmuxManager.sendControl(windowId, 'Enter');
  }

  getActiveSessions(): ActiveSessionInfo[] {
    const sessions: ActiveSessionInfo[] = [];
    for (const [sessionId, session] of this.sessions) {
      sessions.push({
        sessionId,
        cwd: session.cwd,
        adapter: 'claude',
        permissionMode: session.permissionMode,
        lastActivity: session.lastActivity || null,
        hasClients: false,
        hasDesktop: !!(session.lastActivity && (Date.now() - session.lastActivity < 120000)),
        isNonInteractive: session.isNonInteractive || false,
        firstPrompt: session.firstPrompt || null,
      });
    }
    return sessions;
  }

  isProcessing(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!(session?.isProcessing);
  }

  private _startSessionCleanup(): void {
    this._cleanupInterval = setInterval(async () => {
      const windows = await tmuxManager.listWindows();
      const liveWindowIds = new Set(windows.map(w => w.id));

      for (const [sessionId, session] of this.sessions) {
        if (!liveWindowIds.has(session.windowId)) {
          console.log(`[tmux] Stale session ${sessionId} — tmux window gone, cleaning up`);
          this._teardownSession(session);
          this.sessions.delete(sessionId);
          this.emit('session-ended', sessionId);
        }
      }

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
    }, 60000);
    // Don't keep the process alive just for cleanup — allows hooks-cli
    // and other short-lived consumers to exit naturally after their work.
    this._cleanupInterval.unref();
  }

  // === Helpers ===

  private _createSession(windowId: string, cwd: string, cliSessionId: string, permissionMode: string): SessionState {
    return {
      windowId,
      monitor: null,
      watcher: null,
      parser: null,
      cwd,
      cliSessionId,
      permissionMode,
      lastActivity: Date.now(),
      firstPrompt: null,
      isProcessing: false,
      isNonInteractive: false,
      _interactiveChecked: false,
      _promptSenderClientId: null,
      _modeTransitionDeadline: 0,
      _watcherPending: false,
    };
  }

  private _teardownSession(session: SessionState): void {
    if (session.monitor) { session.monitor.stop(); session.monitor = null; }
    if (session.watcher) { session.watcher.stop(); session.watcher = null; session.parser = null; }
  }

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

  // === Internal ===

  private _startMonitor(sessionId: string, windowId: string): void {
    const monitor = new PaneMonitor(windowId);
    monitor.onThinking((thinking) => {
      this.emit('thinking', sessionId, thinking);
    });
    monitor.onStreamingText((text) => {
      this.emit('streaming-text', sessionId, text);
    });
    monitor.start();
    const session = this.sessions.get(sessionId);
    if (session) session.monitor = monitor;
  }

  private async _ensureWatcher(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.watcher || session._watcherPending) return;
    session._watcherPending = true;

    const cliId = sessionId;

    // Construct path directly (we know the UUID and cwd)
    let jsonlPath: string | null = null;
    if (session.cwd && cliId) {
      const encoded = encodeDirName(session.cwd);
      const directPath = join(PROJECTS_DIR, encoded, `${cliId}.jsonl`);
      // Wait for file to appear (Claude creates it on first write)
      // First 25 iterations at 200ms (5s), then 1s intervals for remaining time
      for (let i = 0; i < 50; i++) {
        try {
          await stat(directPath);
          jsonlPath = directPath;
          break;
        } catch {
          await new Promise<void>(r => setTimeout(r, i < 25 ? 200 : 1000));
        }
      }
    }
    // Fallback: search all project dirs
    if (!jsonlPath) jsonlPath = await this._findJsonlPath(cliId);
    if (!jsonlPath) {
      session._watcherPending = false; // Allow retry
      return;
    }

    const parser = new TranscriptParser();
    const watcher = new JsonlWatcher(jsonlPath);

    watcher.onNewEntries((entries) => {
      const { messages, interrupted } = parser.parse(entries as JsonlEntry[]);
      if (messages.length > 0) {
        // Capture first user prompt for active sessions list
        if (!session.firstPrompt) {
          const userMsg = messages.find(m => m.role === 'user');
          if (userMsg) session.firstPrompt = (extractText(userMsg.content) || '').substring(0, 200);
        }

        // Tag user messages with sender's client ID so only the sender skips (dedup)
        for (const msg of messages) {
          if (msg.role === 'user' && session._promptSenderClientId) {
            msg.senderClientId = session._promptSenderClientId;
            session._promptSenderClientId = null;
          }
        }

        this.emit('new-messages', sessionId, messages);
      }
      if (interrupted) {
        this.emit('session-idle', sessionId);
      }
      const tools = parser.getPendingTools();
      if (tools.size > 0) {
        this.emit('tool-updates', sessionId, Object.fromEntries(tools));
      }
    });

    watcher.start({ skipExisting: true });
    session.watcher = watcher;
    session.parser = parser;
    session._watcherPending = false;

    // Backfill firstPrompt from JSONL header (handles race where watcher
    // starts after first user message was already written)
    if (!session.firstPrompt && jsonlPath) {
      try {
        const { firstPrompt } = await parseSessionHeader(jsonlPath, sessionId);
        if (firstPrompt) session.firstPrompt = firstPrompt;
      } catch {}
    }
  }

  private async _findJsonlPath(sessionId: string): Promise<string | null> {
    try {
      const dirs = await readdir(PROJECTS_DIR);
      for (const dir of dirs) {
        const filePath = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          await stat(filePath);
          return filePath;
        } catch {}
      }
    } catch {}
    return null;
  }

  private async _findWindowForSession(sessionId: string, windowList?: TmuxWindow[]): Promise<string | null> {
    const windows = windowList || await tmuxManager.listWindows();
    // Search tmux windows by sessionId (window name = CLI UUID)
    const match = windows.find(w => w.name === sessionId);
    return match?.id || null;
  }

  private async _detectNonInteractive(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session._interactiveChecked) return;
    session._interactiveChecked = true;

    try {
      const content = await tmuxManager.capturePane(session.windowId);
      if (content.includes('claude -p ') || content.includes('claude --print')) {
        session.isNonInteractive = true;
        console.log(`[tmux] Session ${sessionId} detected as non-interactive (claude -p)`);
      }
    } catch {}
  }

  private async _windowExists(windowId: string, windowList?: TmuxWindow[]): Promise<boolean> {
    const windows = windowList || await tmuxManager.listWindows();
    return windows.some(w => w.id === windowId);
  }

  private async _waitForReady(windowId: string, timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      try {
        const content = await tmuxManager.capturePane(windowId);
        const lines = content.split('\n');
        const hasPrompt = lines.some(l => /^\s*❯/.test(l));
        const lineCount = lines.filter(l => l.trim()).length;
        if (attempt <= 3 || attempt % 5 === 0) {
          console.log(`[adapter] waitForReady #${attempt}: window=${windowId} prompt=${hasPrompt} lines=${lineCount}`);
        }
        if (hasPrompt && lineCount >= 3) {
          console.log(`[adapter] CLI ready for ${windowId} in ${Date.now() - start}ms`);
          await new Promise<void>(r => setTimeout(r, 300));
          return;
        }
      } catch (err) {
        console.log(`[adapter] waitForReady #${attempt}: ERROR ${(err as Error).message}`);
      }
      await new Promise<void>(r => setTimeout(r, 1000));
    }
    console.warn(`[adapter] CLI ready timeout for ${windowId} after ${attempt} attempts`);
  }
}

export const tmuxAdapter = new TmuxAdapter();
