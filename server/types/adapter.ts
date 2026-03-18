import type { ToolStatus } from './messages.js';

export interface AdapterCapabilities {
  supportsPlanMode: boolean;
  supportsPermissionModes: boolean;
  supportsInterrupt: boolean;
  supportsResume: boolean;
  supportsAttach: boolean;
  supportsStatusLine: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
  maxContextWindow: number;
  permissionModeType?: 'cycle' | 'toggle';
}

export interface SessionInfo {
  sessionId: string;
  cwd: string | null;
  lastModified?: number | string;
  firstPrompt?: string | null;
  model?: string | null;
}

export interface ModelInfo {
  value: string;
  label: string;
  contextWindow?: number;
}

export interface PermissionModeInfo {
  value: string;
  label: string;
}

export interface EffortLevelInfo {
  value: string;
  label: string;
}

export interface AdapterInfo {
  id: string;
  displayName: string;
  available: boolean;
  capabilities?: AdapterCapabilities;
}

export interface ReconnectState {
  tools: Record<string, ToolStatus>;
  pendingRequests: Array<{
    type: 'permission' | 'question';
    requestId: string;
    toolName?: string;
    input?: Record<string, unknown>;
  }>;
}
