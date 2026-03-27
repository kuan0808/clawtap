// server/adapters/codex/codex-tmux-adapter.ts
//
// Session lifecycle management for Codex CLI sessions running in tmux.
//
// Key difference from Claude's TmuxAdapter:
// - Claude has many hook events (PreToolUse, PostToolUse, etc.) for tool lifecycle
// - Codex only has 3 hooks: SessionStart, UserPromptSubmit, Stop
// - All tool events come from JSONL watching (via CodexTranscriptParser)
// - JSONL watcher starts when SessionStart hook fires (provides transcript_path)

import { EventEmitter } from 'events';
import { tmuxManager } from '../shared/tmux-manager.js';
import { CodexPaneMonitor } from './pane-monitor.js';
import { JsonlWatcher } from '../../stores/jsonl-watcher.js';
import { CodexTranscriptParser } from './transcript-parser.js';
import type { CodexJsonlEntry } from './transcript-parser.js';
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

/** Hook body payload from the Codex CLI */
export interface CodexHookBody {
  session_id: string;
  cwd: string;
  model: string;
  permission_mode: string;
  source: string;            // 'startup' | 'resume' | 'clear'
  transcript_path: string | null;
  hook_event_name: string;
  [key: string]: unknown;
}

/** Internal session state for a managed tmux session */
export interface CodexSessionState {
  windowId: string;
  monitor: CodexPaneMonitor | null;
  watcher: JsonlWatcher | null;
  parser: CodexTranscriptParser | null;
  cwd: string;
  cliSessionId: string;             // UUID from hook session_id
  transcriptPath: string | null;    // from SessionStart hook — path to JSONL file
  approvalPolicy: string;           // 'on-request', 'never', 'untrusted'
  lastActivity: number;
  firstPrompt: string | null;
  isProcessing: boolean;
  _promptSenderClientId: string | null;
  _watcherPending: boolean;         // true until SessionStart hook provides transcript_path
  _matchRetryTimer: ReturnType<typeof setTimeout> | null;
}

/** Hook body with timestamp for age-based cleanup */
type PendingHookBody = CodexHookBody & { _storedAt: number };

/** Resolved session context from _resolveAndTouch */
interface ResolvedContext {
  sessionId: string;
  session: CodexSessionState | undefined;
}

// ---------------------------------------------------------------------------
// CodexTmuxAdapter
// ---------------------------------------------------------------------------

/**
 * CodexTmuxAdapter — manages Codex CLI sessions via tmux.
 *
 * Three channels provide events to the SessionManager:
 * 1. HTTP Hooks (lifecycle): SessionStart, UserPromptSubmit, Stop
 * 2. JSONL Watcher (messages + tools): tool-start, tool-done, new-messages, status-update
 * 3. PaneMonitor (ephemeral): streaming-text, thinking, approval-prompt
 *
 * Events emitted:
 *   streaming-text(sessionId, text)
 *   thinking(sessionId, { text, detail })
 *   tool-start(sessionId, { toolId, toolName, input })
 *   tool-done(sessionId, { toolId, toolName, result })
 *   tool-updates(sessionId, toolsMap)
 *   new-messages(sessionId, messages[])
 *   session-idle(sessionId)
 *   processing-started(sessionId)
 *   status-update(sessionId, { contextPercent, model, cost })
 *   approval-prompt(sessionId, { command, explanation })
 *   session-ended(sessionId)
 */
export class CodexTmuxAdapter extends EventEmitter {
  // sessionId (CLI UUID) -> session state
  sessions: Map<string, CodexSessionState>;
  // Centralized pending permissions/questions manager
  private _permissions: PermissionManager;
  // Set by SessionManager to check if WS clients are connected
  private _clientChecker: ((sessionId: string) => boolean) | null;
  private _cleanupInterval: ReturnType<typeof setInterval> | null;
  private _pendingHookBodies: Map<string, PendingHookBody> = new Map();

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

  async startSession(cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    const parts = ['codex', '--no-alt-screen', '-C', cwd];
    const mode = options.permissionMode;
    this._appendPermissionFlags(parts, mode);
    if (options.model) parts.push('-m', options.model);
    if (options.effort) parts.push('-c', `model_reasoning_effort=${options.effort}`);

    const tempName = `codex-${Date.now()}`;
    const windowId = await tmuxManager.createWindow(tempName, cwd, parts.join(' '));

    // Register session BEFORE _waitForReady — SessionStart hook fires during
    // CLI startup and needs to find this session in the Map for matching.
    const tempKey = tempName;
    const approvalPolicy = mode || 'default';
    this.sessions.set(tempKey, this._createSession(windowId, cwd, '', approvalPolicy));

    await this._waitForReady(windowId);

    // After _waitForReady, SessionStart hook may have fired and rekeyed
    // the session from tempKey to the real CLI UUID. Return the current key.
    // (Currently Codex fires SessionStart after first prompt, so rekey doesn't
    // happen here — but this guards against future CLI timing changes.)
    let finalId = tempKey;
    if (!this.sessions.has(tempKey)) {
      const rekeyed = [...this.sessions.entries()].find(([, s]) => s.windowId === windowId)?.[0];
      if (rekeyed) {
        finalId = rekeyed;
      } else {
        console.warn(`[codex-tmux] Session ${tempKey} vanished during startup (windowId=${windowId})`);
      }
    }

    this._startMonitor(finalId, windowId);

    return { sessionId: finalId, pendingRekey: finalId === tempKey };
  }

  async resumeSession(sessionId: string, cwd: string, options: QueryOptions = {}): Promise<{ sessionId: string }> {
    const session = this.sessions.get(sessionId);
    const codexUuid = session?.cliSessionId || sessionId;
    const mode = options.permissionMode || session?.approvalPolicy || 'default';
    const approvalPolicy = mode;

    // Check if tmux window still alive
    if (session) {
      const windows = await tmuxManager.listWindows();
      if (windows.some(w => w.id === session.windowId)) {
        if (!session.monitor) this._startMonitor(sessionId, session.windowId);
        session.approvalPolicy = approvalPolicy;
        session.lastActivity = Date.now();
        return { sessionId };
      }
      // Window gone — teardown old
      this._teardownSession(session);
    }

    const cliUuid = codexUuid; // CLI UUID for `codex resume <UUID>`
    const parts = ['codex', 'resume', cliUuid, '--no-alt-screen', '-C', cwd];
    this._appendPermissionFlags(parts, mode);
    if (options.model) parts.push('-m', options.model);
    if (options.effort) parts.push('-c', `model_reasoning_effort=${options.effort}`);

    const newSessionId = codexUuid; // Key by CLI UUID
    const windowId = await tmuxManager.createWindow(codexUuid, cwd, parts.join(' '));

    // Register before _waitForReady — same pattern as startSession
    if (session) {
      // Session exists under old key — move to new key (may be same if already CLI UUID)
      if (sessionId !== newSessionId) this.sessions.delete(sessionId);
      session.windowId = windowId;
      session.lastActivity = Date.now();
      session.approvalPolicy = approvalPolicy;
      session._watcherPending = true;
      session.transcriptPath = null;
      session.watcher = null;
      session.parser = null;
      this.sessions.set(newSessionId, session);
    } else {
      this.sessions.set(newSessionId, this._createSession(windowId, cwd, cliUuid, approvalPolicy));
    }

    await this._waitForReady(windowId);

    this._startMonitor(newSessionId, windowId);
    return { sessionId: newSessionId };
  }

  /**
   * Toggle Plan Mode ↔ current mode via Shift+Tab.
   * Codex only supports 2-mode toggle (not Claude's 4-mode cycle).
   */
  async switchPermissionMode(sessionId: string, targetMode: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // One Shift+Tab press toggles Plan ↔ current
    await tmuxManager.sendControl(session.windowId, 'BTab');
    // Update local state — toggle is deterministic (frontend sends correct target)
    session.approvalPolicy = targetMode;
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
      // Large/multiline content: replace newlines with literal \\n so Codex TUI
      // treats it as one message, then use pasteBuffer for speed.
      const singleLine = text.replace(/\n/g, '\\n');

      // Codex TUI shows placeholder text on fresh sessions. pasteBuffer appends
      // to the placeholder, truncating the first ~20 chars. Fix: if content starts
      // with CLAWTAP_REF marker, send it via sendKeys first (clears placeholder),
      // then pasteBuffer the rest.
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
      // Short text: send character-by-character via sendKeys
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
   * Handle the SessionStart hook from Codex CLI.
   *
   * This is the moment we learn the transcript_path and can start the JSONL watcher.
   * It may also be the first time we see the Codex UUID for sessions started via startSession().
   */
  handleSessionStart(body: CodexHookBody): void {
    const codexUuid = body.session_id;
    if (!codexUuid) return;

    // 1. Already managed (resume, or session with known UUID)
    if (this.sessions.has(codexUuid)) {
      this._applySessionStartBody(codexUuid, body);
      return;
    }

    // 2. Find pending sessions (_watcherPending === true)
    const pending = [...this.sessions.entries()].filter(([, s]) => s._watcherPending);
    if (pending.length === 0) return; // Not our session

    // 3. Exactly 1 pending → direct match (no marker needed)
    if (pending.length === 1) {
      const [tempKey] = pending[0];
      console.log(`[codex-tmux] Direct match: ${tempKey} → ${codexUuid}`);
      this._rekeyAndRename(tempKey, codexUuid);
      this._applySessionStartBody(codexUuid, body);
      return;
    }

    // 4. Multiple pending → store, wait for sendMessage to disambiguate via marker
    this._pendingHookBodies.set(codexUuid, { ...body, _storedAt: Date.now() });
  }

  /**
   * Called after sendMessage when _pendingHookBodies has entries.
   * Reads each pending hook body's transcript_path to find the CLAWTAP_REF marker.
   */
  private async _tryMatchPending(tempKey: string): Promise<void> {
    if (await this._scanPendingForMarker(tempKey)) return;

    // Marker not found yet — Codex may still be writing. Retry once after 2s.
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
        console.log(`[codex-tmux] Marker match: ${tempKey} → ${uuid}`);
        this._pendingHookBodies.delete(uuid);
        this._rekeyAndRename(tempKey, uuid);
        this._applySessionStartBody(uuid, body);
        return true;
      } catch { continue; }
    }
    return false;
  }

  /** Apply hook body state and start watcher — shared by all handleSessionStart branches */
  private _applySessionStartBody(sessionId: string, body: CodexHookBody): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.cliSessionId) session.cliSessionId = body.session_id;
    if (body.cwd) session.cwd = body.cwd;
    if (body.permission_mode) session.approvalPolicy = body.permission_mode;
    session.lastActivity = Date.now();
    if (body.transcript_path && !session.transcriptPath) {
      session.transcriptPath = body.transcript_path;
    }

    // Start JSONL watcher if we have a transcript path and watcher isn't already running
    if (session.transcriptPath && !session.watcher) {
      const skipExisting = session.isProcessing !== false;
      this._startWatcher(sessionId, session, skipExisting);
    }
    session._watcherPending = false;
  }

  /**
   * Handle the UserPromptSubmit hook from Codex CLI.
   */
  handleUserPromptSubmit(body: CodexHookBody): void {
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
   * Handle the Stop hook from Codex CLI.
   */
  handleStop(body: CodexHookBody): void {
    const ctx = this._resolveAndTouch(body);
    if (!ctx) return;

    const { sessionId, session } = ctx;
    if (session) {
      session.isProcessing = false;
      if (session.monitor) {
        session.monitor.stop();
        session.monitor = null;
      }
      // Flush JSONL watcher to get final entries
      if (session.watcher) {
        session.watcher.pollNow();
      }
    }

    this.emit('session-idle', sessionId);
    this._permissions.dismissAll(sessionId);
  }

  // === JSONL Watcher ===

  /**
   * Process raw JSONL entries through the transcript parser and emit events.
   */
  private _processWatcherEntries(sessionId: string, rawEntries: unknown[]): void {
    const session = this.sessions.get(sessionId);
    if (!session?.parser) return;

    const entries = rawEntries as CodexJsonlEntry[];
    const result = session.parser.processNewEntries(entries);

    // Emit tool lifecycle events
    for (const ts of result.toolStarts) {
      this.emit('tool-start', sessionId, ts);
    }
    for (const td of result.toolDones) {
      this.emit('tool-done', sessionId, td);
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

    // Emit tool updates map
    if (result.toolUpdates) {
      this.emit('tool-updates', sessionId, result.toolUpdates);
    }

    // Emit status update
    if (result.statusUpdate) {
      this.emit('status-update', sessionId, result.statusUpdate);
    }

    // Handle turn completion from JSONL (task_complete/turn_aborted).
    // Only emit if session is still processing — prevents duplicate session-idle
    // when the Stop hook already fired (hook sets isProcessing=false first).
    if (result.turnComplete && session.isProcessing) {
      session.isProcessing = false;
      if (session.monitor) {
        session.monitor.stop();
        session.monitor = null;
      }
      this.emit('session-idle', sessionId);
    }
  }

  // === Query Methods ===

  getSession(sessionId: string): CodexSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = [];
    for (const [sessionId, session] of this.sessions) {
      result.push({
        sessionId,
        cwd: session.cwd,
        adapter: 'codex',
        permissionMode: session.approvalPolicy,
        lastActivity: session.lastActivity || null,
        hasClients: this._clientChecker ? this._clientChecker(sessionId) : false,
        hasDesktop: !!(session.lastActivity && (Date.now() - session.lastActivity < 120_000)),
        isNonInteractive: false, // Codex doesn't have non-interactive mode detection
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
        state.tools = Object.fromEntries(tools) as unknown as Record<string, import('../../types/messages.js').ToolStatus>;
      }
    }

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

    // Codex approval via tmux keystroke
    if (behavior === 'allow' || behavior === 'allow_session') {
      // Send 'y' to approve
      tmuxManager.sendKeys(session.windowId, 'y', true).catch(() => {});
    } else {
      // Send 'n' to deny
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
    const sessionId = pending?.sessionId || findActiveSession(this.sessions);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (selectedOption != null) {
      // Codex uses single-key shortcuts (y, a, p, d, n)
      tmuxManager.sendKeys(session.windowId, selectedOption, false).catch(() => {});
    }
    if (textValue != null) {
      tmuxManager.sendKeys(session.windowId, textValue, true).catch(() => {});
    }
  }

  /** Release all pending requests for a session (e.g., when Mobile disconnects). */
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

  /** Append the correct permission flags based on the permission mode string. */
  private _appendPermissionFlags(parts: string[], mode?: string): void {
    if (mode === 'bypassPermissions') {
      parts.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (mode === 'fullAuto') {
      parts.push('--full-auto');
    } else if (mode === 'untrusted') {
      parts.push('-a', 'untrusted');
    } else {
      parts.push('-a', 'on-request');
    }
  }

  /** Resolve hook body to internal session, touch lastActivity */
  private _resolveAndTouch(body: CodexHookBody): ResolvedContext | null {
    const sessionId = body.session_id;
    if (!sessionId || !this.sessions.has(sessionId)) return null;

    const session = this.sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();

    return { sessionId, session };
  }

  private _createSession(
    windowId: string,
    cwd: string,
    cliSessionId: string,
    approvalPolicy: string,
  ): CodexSessionState {
    return {
      windowId,
      monitor: null,
      watcher: null,
      parser: null,
      cwd,
      cliSessionId,
      transcriptPath: null,
      approvalPolicy,
      lastActivity: Date.now(),
      firstPrompt: null,
      isProcessing: false,
      _promptSenderClientId: null,
      _watcherPending: true,
      _matchRetryTimer: null,
    };
  }

  /**
   * Wait for Codex CLI to be ready (show the › prompt).
   * Polls tmux pane content until the prompt indicator appears.
   */
  private async _waitForReady(windowId: string, timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      try {
        const content = await tmuxManager.capturePane(windowId);
        const lines = content.split('\n');
        // Codex shows › as the input prompt
        const hasPrompt = lines.some(l => /^\s*›/.test(l));
        const lineCount = lines.filter(l => l.trim()).length;
        if (attempt <= 3 || attempt % 5 === 0) {
          console.log(`[codex-tmux] waitForReady #${attempt}: window=${windowId} prompt=${hasPrompt} lines=${lineCount}`);
        }
        if (hasPrompt && lineCount >= 3) {
          console.log(`[codex-tmux] CLI ready for ${windowId} in ${Date.now() - start}ms`);
          // Extra settle time for Codex TUI to fully render after prompt appears
          await new Promise<void>(r => setTimeout(r, 300));
          return;
        }
      } catch (err) {
        console.log(`[codex-tmux] waitForReady #${attempt}: ERROR ${(err as Error).message}`);
      }
      await new Promise<void>(r => setTimeout(r, 500));
    }
    console.warn(`[codex-tmux] Timed out waiting for CLI ready on ${windowId}`);
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

    // Stop existing monitor if any
    if (session.monitor) {
      session.monitor.stop();
    }

    const monitor = new CodexPaneMonitor(sessionId, windowId, tmuxManager, this);
    monitor.start();
    session.monitor = monitor;
  }

  private _startWatcher(sessionId: string, session: CodexSessionState, skipExisting = true): void {
    if (!session.transcriptPath) return;
    if (session.watcher) return;

    const parser = new CodexTranscriptParser();
    const watcher = new JsonlWatcher(session.transcriptPath);

    watcher.onNewEntries((entries) => {
      this._processWatcherEntries(sessionId, entries);
    });

    watcher.start({ skipExisting, fallbackIntervalMs: 1000 });
    session.watcher = watcher;
    session.parser = parser;
    session._watcherPending = false;
  }

  private _teardownSession(session: CodexSessionState): void {
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
          console.log(`[codex-tmux] Stale session ${sessionId} — tmux window gone, cleaning up`);
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
    // Don't keep the process alive just for cleanup
    this._cleanupInterval.unref();
  }
}
