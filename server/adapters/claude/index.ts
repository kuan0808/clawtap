// server/adapters/claude/index.ts
import { IAdapter } from '../interface.js';
import type { DirectoryEntry, ActiveSessionInfo, MessagesResult, CachedStatus } from '../interface.js';
import { TmuxAdapter } from './tmux-adapter.js';
import type { SessionState, HookBody } from './tmux-adapter.js';
import { ClaudeHookConfig } from './hook-config.js';
import {
  getSessions, getMessages, listDirectory,
} from './jsonl-store.js';
import type { SessionHeaderResult, GetMessagesResult } from './jsonl-store.js';
import type { QueryOptions, PermissionBehavior } from '../../types/messages.js';
import type { AdapterCapabilities, ModelInfo, PermissionModeInfo, EffortLevelInfo, ReconnectState, SessionInfo } from '../../types/adapter.js';
import type { Express } from 'express';

/** Statusline body from Claude CLI */
interface StatusLineBody {
  session_id?: string;
  permission_mode?: string;
  context_window?: { used_percentage?: number };
  model?: { display_name?: string };
  cost?: { total_cost_usd?: number };
  [key: string]: unknown;
}



const MODELS: ModelInfo[] = [
  { value: 'sonnet', label: 'Sonnet', contextWindow: 200000 },
  { value: 'opus', label: 'Opus', contextWindow: 200000 },
  { value: 'haiku', label: 'Haiku', contextWindow: 200000 },
  { value: 'opus[1m]', label: 'Opus 1M', contextWindow: 1000000 },
  { value: 'sonnet[1m]', label: 'Sonnet 1M', contextWindow: 1000000 },
];

const PERMISSION_MODES: PermissionModeInfo[] = [
  { value: 'default', label: 'Normal' },
  { value: 'acceptEdits', label: 'Auto-edit' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'YOLO' },
];

const EFFORT_LEVELS: EffortLevelInfo[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export class ClaudeAdapter extends IAdapter {
  static id: string = 'claude';
  static displayName: string = 'Claude Code';
  static command: string = 'claude';

  private _tmux: TmuxAdapter;
  private _hookConfig: ClaudeHookConfig;
  private _lastStatus: Map<string, CachedStatus>; // sessionId → { contextPercent, model, cost }

  constructor() {
    super();
    this._tmux = new TmuxAdapter();
    this._hookConfig = new ClaudeHookConfig();
    this._lastStatus = new Map();
    // Forward all events from internal tmux adapter
    const events: string[] = [
      'streaming-text', 'thinking', 'tool-start', 'tool-done',
      'tool-updates', 'new-messages', 'session-idle',
      'permission-request', 'ask-question', 'mode-changed',
      'session-ended', 'session-error', 'compacting', 'compact-done',
      'processing-started',
    ];
    for (const event of events) {
      this._tmux.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }

    // Clean up statusline dedup cache when session ends
    this._tmux.on('session-ended', (sessionId: string) => {
      this._lastStatus.delete(sessionId);
    });
  }

  setup(app: Express): void {
    this.installHooks();
    this._registerHookRoutes(app);
  }

  installHooks(): void { this._hookConfig.install(); }
  uninstallHooks(): void { this._hookConfig.uninstall(); }

  async cleanup(): Promise<void> {
    this.uninstallHooks();
    await this._tmux.destroy();
  }

  /**
   * Register Express routes for Claude-specific hooks.
   * These are called by the Claude CLI from localhost (no auth needed).
   */
  private _registerHookRoutes(app: Express): void {
    // All hooks are fire-and-forget notifications — no return value used.
    // Handlers are called for side effects only (emit events, update state).
    const hookRoute = (path: string, handler: (body: HookBody) => void | Promise<void>): void => {
      const label = path.split('/').pop();
      app.post(path, (req: any, res: any) => {
        const sid = req.body.session_id?.substring(0, 8) || '?';
        const toolInfo = req.body.tool_name ? ` ${req.body.tool_name}` : '';
        console.log(`[hook] ${label}:${toolInfo} sid=${sid}`);
        try {
          const result = handler(req.body);
          if (result instanceof Promise) result.catch((e: Error) => console.error(`[hook] ${label} error:`, e.message));
        } catch (e) { console.error(`[hook] ${label} error:`, (e as Error).message); }
        res.json({});
      });
    };

    const prefix = this.getHookPrefix(); // /api/hooks/claude

    hookRoute(`${prefix}/pre-tool-use`, (body) => {
      this._tmux.handlePreToolUse(body);
    });
    hookRoute(`${prefix}/post-tool-use`, (body) => {
      this._tmux.handlePostToolUse(body);
    });
    hookRoute(`${prefix}/stop`, (body) => {
      this._tmux.handleStop(body);
    });
    hookRoute(`${prefix}/permission-request`, (body) => {
      this._tmux.handlePermissionRequest(body);
    });
    hookRoute(`${prefix}/user-prompt-submit`, (body) => {
      this._tmux.handleUserPromptSubmit(body);
    });
    hookRoute(`${prefix}/session-end`, (body) => {
      this._tmux.handleSessionEnd(body);
    });
    hookRoute(`${prefix}/post-tool-use-failure`, (body) => {
      this._tmux.handlePostToolUseFailure(body);
    });
    hookRoute(`${prefix}/stop-failure`, (body) => {
      this._tmux.handleStopFailure(body);
    });
    hookRoute(`${prefix}/pre-compact`, (body) => {
      this._tmux.handlePreCompact(body);
    });
    hookRoute(`${prefix}/post-compact`, (body) => {
      this._tmux.handlePostCompact(body);
    });
    hookRoute(`${prefix}/session-start`, (body) => {
      this._tmux.handleSessionStart(body);
    });
    hookRoute(`${prefix}/statusline`, (body) => {
      this._handleStatusLine(body as StatusLineBody);
    });
  }

  /**
   * Handle statusline hook — extract metrics, sync permission mode,
   * deduplicate, and emit 'status-update' event.
   */
  private _handleStatusLine(body: StatusLineBody): void {
    const sessionId = body.session_id;
    if (!sessionId || !this._tmux.getSession(sessionId)) return;

    // Sync permission mode from statusline — catches desktop Shift+Tab changes
    // that don't trigger other hooks (PreToolUse, Stop, etc.)
    this._tmux.syncPermissionMode(sessionId, body);

    const contextPercent = body.context_window?.used_percentage ?? null;
    const model = body.model?.display_name ?? null;
    const cost = body.cost?.total_cost_usd ?? null;

    // Deduplicate — skip if nothing changed
    const prev = this._lastStatus.get(sessionId);
    if (prev &&
        prev.contextPercent === contextPercent &&
        prev.model === model &&
        prev.cost === cost) return;

    const status: CachedStatus = { contextPercent, model, cost };
    this._lastStatus.set(sessionId, status);
    this.emit('status-update', sessionId, status);
  }

  setClientChecker(fn: (sessionId: string) => boolean): void {
    this._tmux.setClientChecker(fn);
  }

  // Lifecycle — delegate to tmux adapter
  async startSession(cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { return this._tmux.startSession(cwd, options); }
  async resumeSession(sid: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { return this._tmux.resumeSession(sid, cwd, options); }
  async attachSession(sid: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { return this._tmux.attachSession(sid, cwd, options); }
  async destroySession(sid: string): Promise<void> { return this._tmux.destroySession(sid); }
  async sendMessage(sid: string, text: string, options?: QueryOptions): Promise<void> { return this._tmux.sendMessage(sid, text, options); }
  async respondPlan(sid: string, optionIndex: number, text?: string): Promise<void> { return this._tmux.respondPlan(sid, optionIndex, text); }
  async switchModel(sid: string, model: string): Promise<void> { return this._tmux.switchModel(sid, model); }
  async interrupt(sid: string): Promise<void> { return this._tmux.interrupt(sid); }
  flushMessages(sid: string): void { this._tmux.flushMessages(sid); }
  syncWatcherPosition(sid: string): void { this._tmux.syncWatcherPosition(sid); }
  getReconnectState(sid: string): ReconnectState { return this._tmux.getReconnectState(sid); }

  // Store — delegate to jsonl-store
  async getSessions(dir?: string, limit?: number): Promise<SessionInfo[]> { return getSessions(dir, limit); }
  async getMessages(sid: string, dir?: string): Promise<GetMessagesResult> { return getMessages(sid, dir); }
  async listDirectory(path?: string): Promise<DirectoryEntry[]> { return listDirectory(path); }

  // Permissions — delegate to tmux adapter
  async switchPermissionMode(sid: string, mode: string): Promise<boolean> { return this._tmux.switchPermissionMode(sid, mode); }
  respondPermission(reqId: string, behavior: PermissionBehavior): void { this._tmux.respondPermission(reqId, behavior); }
  async respondQuestion(reqId: string, answer: string): Promise<void> { return this._tmux.respondQuestion(reqId, answer); }
  releaseAllPending(sid: string): void { this._tmux.releaseAllPending(sid); }
  resolveAllPendingAs(sid: string, behavior: PermissionBehavior): void { this._tmux.resolveAllPendingAs(sid, behavior); }

  // Query
  isProcessing(sid: string): boolean { return this._tmux.isProcessing(sid); }
  getSession(sid: string): SessionState | undefined { return this._tmux.getSession(sid); }
  getLastStatus(sid: string) { return this._lastStatus.get(sid) || null; }
  async hasActiveWindow(sid: string): Promise<boolean> { return this._tmux.hasActiveWindow(sid); }
  getActiveSessions(): ActiveSessionInfo[] { return this._tmux.getActiveSessions(); }

  // Capabilities
  getModels(): ModelInfo[] { return MODELS; }
  getPermissionModes(): PermissionModeInfo[] { return PERMISSION_MODES; }
  getEffortLevels(): EffortLevelInfo[] { return EFFORT_LEVELS; }
  getEffortLabel(): string { return 'Thinking'; }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsPlanMode: true,
      supportsPermissionModes: true,
      supportsInterrupt: true,
      supportsResume: true,
      supportsAttach: true,
      supportsStatusLine: true,
      supportsImages: true,
      supportsStreaming: true,
      maxContextWindow: 1_000_000,
      permissionModeType: 'cycle',
    };
  }

}
