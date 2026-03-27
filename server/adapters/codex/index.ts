// server/adapters/codex/index.ts
import { IAdapter } from '../interface.js';
import type { DirectoryEntry, ActiveSessionInfo, MessagesResult, CachedStatus } from '../interface.js';
import { CodexTmuxAdapter } from './codex-tmux-adapter.js';
import type { CodexSessionState, CodexHookBody } from './codex-tmux-adapter.js';
import { CodexHookConfig } from './hook-config.js';
import {
  getSessions, getMessages, listDirectory,
} from './jsonl-store.js';
import type { QueryOptions, PermissionBehavior } from '../../types/messages.js';
import type { AdapterCapabilities, ModelInfo, PermissionModeInfo, EffortLevelInfo, ReconnectState, SessionInfo } from '../../types/adapter.js';
import type { Express } from 'express';



const MODELS: ModelInfo[] = [
  { value: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 258400 },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', contextWindow: 258400 },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', contextWindow: 258400 },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', contextWindow: 258400 },
  { value: 'gpt-5.2', label: 'GPT-5.2', contextWindow: 258400 },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', contextWindow: 258400 },
  { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', contextWindow: 258400 },
  { value: 'gpt-5.1', label: 'GPT-5.1', contextWindow: 258400 },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex', contextWindow: 258400 },
  { value: 'gpt-5', label: 'GPT-5', contextWindow: 258400 },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', contextWindow: 258400 },
  { value: 'gpt-5-codex-mini', label: 'GPT-5 Codex Mini', contextWindow: 258400 },
];

const PERMISSION_MODES: PermissionModeInfo[] = [
  { value: 'default', label: 'Suggest' },
  { value: 'fullAuto', label: 'Full Auto' },
  { value: 'untrusted', label: 'Untrusted' },
  { value: 'bypassPermissions', label: 'YOLO' },
];

const EFFORT_LEVELS: EffortLevelInfo[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

export class CodexAdapter extends IAdapter {
  static id: string = 'codex';
  static displayName: string = 'Codex CLI';
  static command: string = 'codex';

  private _tmux: CodexTmuxAdapter;
  private _hookConfig: CodexHookConfig;
  private _lastStatus: Map<string, CachedStatus>; // sessionId → { contextPercent, model, cost }

  constructor() {
    super();
    this._tmux = new CodexTmuxAdapter();
    this._hookConfig = new CodexHookConfig();
    this._lastStatus = new Map();

    // Forward all events from internal tmux adapter
    const events: string[] = [
      'streaming-text', 'thinking', 'tool-start', 'tool-done',
      'tool-updates', 'new-messages', 'session-idle',
      'permission-request', 'ask-question', 'mode-changed',
      'session-ended', 'session-error', 'compacting', 'compact-done',
      'processing-started', 'session-rekeyed',
    ];
    for (const event of events) {
      this._tmux.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }

    // Don't forward status-update blindly — deduplicate first
    this._tmux.on('status-update', (sessionId: string, status: any) => {
      const prev = this._lastStatus.get(sessionId);
      if (prev &&
          prev.contextPercent === status.contextPercent &&
          prev.model === status.model &&
          prev.cost === status.cost) return;
      this._lastStatus.set(sessionId, status);
      this.emit('status-update', sessionId, status);
    });

    // Clean up status dedup cache when session ends
    this._tmux.on('session-ended', (sessionId: string) => {
      this._lastStatus.delete(sessionId);
    });
  }

  setup(app: Express): void {
    this._registerHookRoutes(app);
  }

  setHookPort(port: number | string): void { this._hookConfig.port = port; }
  installHooks(): void { this._hookConfig.install(); }
  uninstallHooks(): void { this._hookConfig.uninstall(); }

  async cleanup(): Promise<void> {
    this.uninstallHooks();
    await this._tmux.destroy();
  }

  /**
   * Register Express routes for Codex-specific hooks.
   * These are called by the Codex CLI from localhost (no auth needed).
   */
  private _registerHookRoutes(app: Express): void {
    // All hooks are fire-and-forget notifications — no return value used.
    // Handlers are called for side effects only (emit events, update state).
    const hookRoute = (path: string, handler: (body: CodexHookBody) => void | Promise<void>): void => {
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

    const prefix = this.getHookPrefix(); // /api/hooks/codex

    hookRoute(`${prefix}/session-start`, (body) => {
      this._tmux.handleSessionStart(body);
    });
    hookRoute(`${prefix}/user-prompt-submit`, (body) => {
      this._tmux.handleUserPromptSubmit(body);
    });
    hookRoute(`${prefix}/stop`, (body) => {
      this._tmux.handleStop(body);
    });
  }

  setClientChecker(fn: (sessionId: string) => boolean): void {
    this._tmux.setClientChecker(fn);
  }

  // Lifecycle — delegate to tmux adapter
  async startSession(cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> {
    try { this._hookConfig.trustDirectory(cwd); } catch {} // Auto-trust cwd to prevent interactive prompt
    return this._tmux.startSession(cwd, options);
  }
  async resumeSession(sid: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> {
    if (cwd) try { this._hookConfig.trustDirectory(cwd); } catch {}
    return this._tmux.resumeSession(sid, cwd, options);
  }
  async attachSession(_sid: string, _cwd: string, _options?: QueryOptions): Promise<{ sessionId: string }> { throw new Error('Codex does not support attach'); }
  async destroySession(sid: string): Promise<void> { return this._tmux.destroySession(sid); }
  async sendMessage(sid: string, text: string, options?: QueryOptions): Promise<void> { return this._tmux.sendMessage(sid, text, options); }
  async switchModel(sid: string, model: string): Promise<void> { return this._tmux.switchModel(sid, model); }
  async interrupt(sid: string): Promise<void> { return this._tmux.interrupt(sid); }
  flushMessages(sid: string): void { this._tmux.flushMessages(sid); }
  syncWatcherPosition(sid: string): void { this._tmux.syncWatcherPosition(sid); }
  getReconnectState(sid: string): ReconnectState { return this._tmux.getReconnectState(sid); }

  // Store — delegate to jsonl-store
  async getSessions(dir?: string, limit?: number): Promise<SessionInfo[]> { return getSessions(dir, limit); }
  async getMessages(sid: string, dir?: string): Promise<MessagesResult> { return getMessages(sid, dir); }
  async listDirectory(path?: string): Promise<DirectoryEntry[]> { return listDirectory(path); }

  // Permissions — delegate to tmux adapter
  async switchPermissionMode(sid: string, mode: string): Promise<boolean> { return this._tmux.switchPermissionMode(sid, mode); }
  respondPermission(reqId: string, behavior: PermissionBehavior): void { this._tmux.respondPermission(reqId, behavior); }
  async respondQuestion(reqId: string, answer: string): Promise<void> { return this._tmux.respondQuestion(reqId, answer); }
  respondInteractivePrompt(reqId: string, opt?: string, text?: string): void { this._tmux.respondInteractivePrompt(reqId, opt, text); }
  releaseAllPending(sid: string): void { this._tmux.releaseAllPending(sid); }
  resolveAllPendingAs(sid: string, behavior: PermissionBehavior): void { this._tmux.resolveAllPendingAs(sid, behavior); }

  // Query
  isProcessing(sid: string): boolean { return this._tmux.isProcessing(sid); }
  getSession(sid: string): CodexSessionState | undefined { return this._tmux.getSession(sid); }
  getLastStatus(sid: string) { return this._lastStatus.get(sid) || null; }
  async hasActiveWindow(sid: string): Promise<boolean> { return this._tmux.hasActiveWindow(sid); }
  getActiveSessions(): ActiveSessionInfo[] { return this._tmux.getActiveSessions(); }

  // Capabilities
  getModels(): ModelInfo[] { return MODELS; }
  getPermissionModes(): PermissionModeInfo[] { return PERMISSION_MODES; }
  getEffortLevels(): EffortLevelInfo[] { return EFFORT_LEVELS; }
  getEffortLabel(): string { return 'Effort'; }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsPlanMode: false,
      supportsPermissionModes: true,
      supportsInterrupt: true,
      supportsResume: true,
      supportsAttach: false,
      supportsStatusLine: true,
      supportsImages: true,
      supportsStreaming: true,
      maxContextWindow: 258_400,
      permissionModeType: 'toggle',
    };
  }
}
