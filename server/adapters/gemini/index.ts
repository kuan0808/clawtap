// server/adapters/gemini/index.ts
import { IAdapter } from '../interface.js';
import type { DirectoryEntry, ActiveSessionInfo, MessagesResult, CachedStatus } from '../interface.js';
import { GeminiTmuxAdapter } from './gemini-tmux-adapter.js';
import type { GeminiSessionState, GeminiHookBody } from './gemini-tmux-adapter.js';
import { GeminiHookConfig } from './hook-config.js';
import {
  getSessions, getSessionMessages, listDirectory,
} from './json-store.js';
import { GeminiTranscriptParser } from './transcript-parser.js';
import type { QueryOptions, PermissionBehavior } from '../../types/messages.js';
import type { AdapterCapabilities, ModelInfo, PermissionModeInfo, EffortLevelInfo, ReconnectState, SessionInfo } from '../../types/adapter.js';
import type { Express } from 'express';



const MODELS: ModelInfo[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'pro', label: 'Gemini Pro' },
  { value: 'flash', label: 'Gemini Flash' },
  { value: 'flash-lite', label: 'Flash Lite' },
];

const PERMISSION_MODES: PermissionModeInfo[] = [
  { value: 'default', label: 'Default' },
  { value: 'auto_edit', label: 'Auto Edit' },
  { value: 'yolo', label: 'YOLO' },
  { value: 'plan', label: 'Plan' },
];

export class GeminiAdapter extends IAdapter {
  static id: string = 'gemini';
  static displayName: string = 'Gemini CLI';
  static command: string = 'gemini';

  private _tmux: GeminiTmuxAdapter;
  private _hookConfig: GeminiHookConfig;
  private _lastStatus: Map<string, CachedStatus>; // sessionId -> { contextPercent, model, cost }

  constructor() {
    super();
    this._tmux = new GeminiTmuxAdapter();
    this._hookConfig = new GeminiHookConfig();
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
   * Register Express routes for Gemini-specific hooks.
   * These are called by the Gemini CLI bridge script from localhost (no auth needed).
   */
  private _registerHookRoutes(app: Express): void {
    // All hooks are fire-and-forget notifications — no return value used.
    // Handlers are called for side effects only (emit events, update state).
    const hookRoute = (path: string, handler: (body: GeminiHookBody) => void | Promise<void>): void => {
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

    const prefix = this.getHookPrefix(); // /api/hooks/gemini

    hookRoute(`${prefix}/session-start`, (body) => {
      this._tmux.handleSessionStart(body);
    });
    hookRoute(`${prefix}/session-end`, (body) => {
      this._tmux.handleSessionEnd(body);
    });
    hookRoute(`${prefix}/before-tool`, (body) => {
      this._tmux.handleBeforeTool(body);
    });
    hookRoute(`${prefix}/after-tool`, (body) => {
      this._tmux.handleAfterTool(body);
    });
    hookRoute(`${prefix}/before-agent`, (body) => {
      this._tmux.handleBeforeAgent(body);
    });
    hookRoute(`${prefix}/after-agent`, (body) => {
      this._tmux.handleAfterAgent(body);
    });
  }

  setClientChecker(fn: (sessionId: string) => boolean): void {
    this._tmux.setClientChecker(fn);
  }

  // Lifecycle — delegate to tmux adapter
  async startSession(cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> {
    return this._tmux.startSession(cwd, options);
  }
  async resumeSession(sid: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> {
    return this._tmux.resumeSession(sid, cwd, options);
  }
  async attachSession(_sid: string, _cwd: string, _options?: QueryOptions): Promise<{ sessionId: string }> { throw new Error('Gemini does not support attach'); }
  async destroySession(sid: string): Promise<void> { return this._tmux.destroySession(sid); }
  async sendMessage(sid: string, text: string, options?: QueryOptions): Promise<void> { return this._tmux.sendMessage(sid, text, options); }
  async switchModel(sid: string, model: string): Promise<void> { return this._tmux.switchModel(sid, model); }
  async interrupt(sid: string): Promise<void> { return this._tmux.interrupt(sid); }
  flushMessages(sid: string): void { this._tmux.flushMessages(sid); }
  syncWatcherPosition(sid: string): void { this._tmux.syncWatcherPosition(sid); }
  getReconnectState(sid: string): ReconnectState { return this._tmux.getReconnectState(sid); }

  // Store — delegate to json-store, parse through transcript parser for getMessages
  async getSessions(dir?: string, limit?: number): Promise<SessionInfo[]> { return getSessions(dir, limit); }

  async getMessages(sid: string, dir?: string): Promise<MessagesResult> {
    const { messages: rawMessages, lastModified } = getSessionMessages(sid, dir);
    if (rawMessages.length === 0) return { messages: [], lastModified };

    // Parse raw Gemini messages through the transcript parser
    const parser = new GeminiTranscriptParser();
    const { messages } = parser.parse(rawMessages as import('../../stores/json-watcher.js').GeminiSessionMessage[]);
    return { messages, lastModified };
  }

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
  getSession(sid: string): GeminiSessionState | undefined { return this._tmux.getSession(sid); }
  getLastStatus(sid: string) { return this._lastStatus.get(sid) || null; }
  async hasActiveWindow(sid: string): Promise<boolean> { return this._tmux.hasActiveWindow(sid); }
  getActiveSessions(): ActiveSessionInfo[] { return this._tmux.getActiveSessions(); }

  // Capabilities
  getModels(): ModelInfo[] { return MODELS; }
  getPermissionModes(): PermissionModeInfo[] { return PERMISSION_MODES; }
  getEffortLevels(): EffortLevelInfo[] { return []; }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsPlanMode: true,
      supportsPermissionModes: true,
      supportsInterrupt: true,
      supportsResume: true,
      supportsAttach: false,
      supportsStatusLine: false,
      supportsImages: true,
      supportsStreaming: true,
      maxContextWindow: 1_000_000,
      permissionModeType: 'toggle',
    };
  }
}
