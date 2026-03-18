// server/adapters/interface.ts
import { EventEmitter } from 'events';
import type { Express } from 'express';
import type { QueryOptions, PermissionBehavior, PermissionMode, ChatMessage } from '../types/messages.js';
import type {
  AdapterCapabilities, SessionInfo, ModelInfo,
  PermissionModeInfo, EffortLevelInfo, ReconnectState,
} from '../types/adapter.js';

/** Threshold for switching from sendKeys (character-by-character) to pasteBuffer (bulk paste) */
export const PASTE_THRESHOLD = 500;

/** Check if text should be sent via pasteBuffer instead of sendKeys */
export function isLargeContent(text: string): boolean {
  return text.length > PASTE_THRESHOLD || text.includes('\n');
}

/** Cached session status for deduplication and reconnect */
export interface CachedStatus {
  contextPercent: number | null;
  model: string | null;
  cost: number | null;
}

/** Directory entry returned by listDirectory */
export interface DirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

/** Active session info returned by getActiveSessions */
export interface ActiveSessionInfo {
  sessionId: string;
  cwd: string;
  adapter: string;
  permissionMode: string;
  lastActivity: number | null;
  hasClients: boolean;
  hasDesktop: boolean;
  isNonInteractive: boolean;
  firstPrompt: string | null;
}

/** Messages result from getMessages */
export interface MessagesResult {
  messages: unknown[];
  lastModified: string | null;
}

/**
 * IAdapter — Base class for CLI agent adapters.
 *
 * Each adapter is a self-contained plugin that:
 * - Manages CLI process lifecycle (start, resume, attach, destroy)
 * - Registers its own HTTP hook routes via setup(app)
 * - Owns its session store (getSessions, getMessages)
 * - Emits standardized events for the session manager
 *
 * Events (all emit sessionId as first arg):
 *   streaming-text(sessionId, text)
 *   thinking(sessionId, { text, detail })
 *   tool-start(sessionId, { toolId, toolName, input })
 *   tool-done(sessionId, { toolId, toolName, result })
 *   tool-updates(sessionId, toolsMap)
 *   new-messages(sessionId, messages[])
 *   session-idle(sessionId)
 *   permission-request(sessionId, { requestId, toolName, input })
 *   ask-question(sessionId, { requestId, toolName, input })
 *   status-update(sessionId, { contextPercent, model, cost })
 */
export class IAdapter extends EventEmitter {
  /** Unique adapter identifier (e.g. 'claude', 'codex') */
  static id: string = '';
  /** Human-readable name (e.g. 'Claude Code') */
  static displayName: string = '';
  /** CLI binary name for auto-detection (e.g. 'claude') */
  static command: string = '';

  protected _clientChecker: ((sessionId: string) => boolean) | null = null;

  /**
   * Register adapter-specific HTTP routes and configure CLI hooks.
   * Called once during server startup.
   */
  setup(app: Express): void { throw new Error('Not implemented: setup'); }

  /**
   * Set a function that checks if WS clients are connected for a session.
   */
  setClientChecker(fn: (sessionId: string) => boolean): void { this._clientChecker = fn; }

  // --- Session Lifecycle ---

  async startSession(cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { throw new Error('Not implemented: startSession'); }
  async resumeSession(sessionId: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { throw new Error('Not implemented: resumeSession'); }
  async attachSession(sessionId: string, cwd: string, options?: QueryOptions): Promise<{ sessionId: string }> { throw new Error('Not implemented: attachSession'); }
  async destroySession(sessionId: string): Promise<void> { throw new Error('Not implemented: destroySession'); }

  // --- Messaging ---

  async sendMessage(sessionId: string, text: string, options?: QueryOptions): Promise<void> { throw new Error('Not implemented: sendMessage'); }
  async respondPlan(sessionId: string, optionIndex: number, text?: string): Promise<void> {}
  async interrupt(sessionId: string): Promise<void> { throw new Error('Not implemented: interrupt'); }
  async switchModel(sessionId: string, model: string): Promise<void> {}
  flushMessages(sessionId: string): void {}
  syncWatcherPosition(sessionId: string): void {}
  getReconnectState(sessionId: string): ReconnectState { return { tools: {} as Record<string, any>, pendingRequests: [] }; }

  // --- Session Store ---

  async getSessions(dir?: string, limit?: number): Promise<SessionInfo[]> { throw new Error('Not implemented: getSessions'); }
  async getMessages(sessionId: string, dir?: string): Promise<MessagesResult> { throw new Error('Not implemented: getMessages'); }
  async listDirectory(path?: string): Promise<DirectoryEntry[]> { throw new Error('Not implemented: listDirectory'); }

  // --- Permissions ---

  async switchPermissionMode(sessionId: string, mode: string): Promise<boolean> { return false; }
  respondPermission(requestId: string, behavior: PermissionBehavior): void {}
  async respondQuestion(requestId: string, answer: string): Promise<void> {}
  releaseAllPending(sessionId: string): void {}
  resolveAllPendingAs(sessionId: string, behavior: PermissionBehavior): void {}

  // --- Query ---

  getSession(sessionId: string): unknown { return null; }
  getLastStatus(sessionId: string): { contextPercent: number | null; model: string | null; cost: number | null } | null { return null; }
  getActiveSessions(): ActiveSessionInfo[] { return []; }
  async hasActiveWindow(sessionId: string): Promise<boolean> { return false; }

  // --- Capabilities ---

  getModels(): ModelInfo[] { return []; }
  getPermissionModes(): PermissionModeInfo[] { return []; }
  getEffortLevels(): EffortLevelInfo[] { return []; }
  getEffortLabel(): string { return 'Effort'; }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsPlanMode: false,
      supportsPermissionModes: false,
      supportsInterrupt: false,
      supportsResume: false,
      supportsAttach: false,
      supportsStatusLine: false,
      supportsImages: false,
      supportsStreaming: true,
      maxContextWindow: 0,
    };
  }

  getHookPrefix(): string {
    return `/api/hooks/${(this.constructor as any).id}`;
  }

  // --- Hooks ---

  /** Install adapter-specific hooks (e.g., write to CLI settings). No server needed. */
  installHooks(): void {}
  /** Remove adapter-specific hooks. No server needed. */
  uninstallHooks(): void {}

  // --- Lifecycle ---

  /** Called on server shutdown to clean up external config (e.g. CLI hooks). */
  async cleanup(): Promise<void> {}

  /** Check if a session is actively processing a request. */
  isProcessing(sessionId: string): boolean { return false; }
}
