export type ServerMessageType =
  | 'session-created' | 'session-state' | 'text-delta' | 'thinking'
  | 'tool-start' | 'tool-done' | 'tool-updates' | 'message-complete'
  | 'permission-request' | 'permission-dismissed' | 'history-load'
  | 'turn-complete' | 'status-update' | 'mode-updated'
  | 'compacting' | 'compact-done' | 'session-error' | 'session-ended'
  | 'client-id' | 'pending-notifications' | 'error'
  | 'review-started' | 'review-ended';

export interface ServerMessage {
  type: ServerMessageType;
  [key: string]: unknown;
}

export type ClientMessageType =
  | 'query' | 'permission-response' | 'ask-response' | 'abort'
  | 'reconnect' | 'set-permission-mode' | 'plan-response';

export interface ClientMessage {
  type: ClientMessageType;
  [key: string]: unknown;
}

export interface QueryOptions {
  adapter?: string;
  cwd?: string;
  model?: string;
  sessionId?: string;
  permissionMode?: string;
  effort?: string;
  images?: string[];
  clientId?: string;
}

export type PermissionBehavior = 'allow' | 'allow_session' | 'deny';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: MessageContent[];
  interrupted?: boolean;
  plan?: string;
  senderClientId?: string;
  id?: string;              // unique message ID
  adapter?: string;         // 'claude' | 'codex'
  timestamp?: string;       // ISO 8601
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ToolStatus {
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'success' | 'error' | 'interrupted';
  result?: string;
  error?: string;
}

export interface SessionStatus {
  contextPercent: number;
  model: string;
  cost: number;
}

export interface InteractivePrompt {
  requestId: string;
  promptType: 'permission' | 'question' | 'plan' | 'loop-detected';
  title: string;
  description: string;
  toolName?: string;
  toolInput?: any;
  options?: { value: string; label: string }[];
  textInput?: { placeholder?: string };
}

export interface PromptResponse {
  requestId: string;
  selectedOption?: string;
  textValue?: string;
}
