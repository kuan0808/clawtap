export const WS = {
  // Client → Server
  QUERY: 'query',
  PERMISSION_RESPONSE: 'permission-response',
  ASK_RESPONSE: 'ask-response',
  ABORT: 'abort',
  RECONNECT: 'reconnect',
  SET_PERMISSION_MODE: 'set-permission-mode',
  SET_MODEL: 'set-model',
  PLAN_RESPONSE: 'plan-response',
  // Server → Client
  SESSION_CREATED: 'session-created',
  TEXT_DELTA: 'text-delta',
  THINKING: 'thinking',
  TOOL_START: 'tool-start',
  TOOL_DONE: 'tool-done',
  MESSAGE_COMPLETE: 'message-complete',
  TOOL_UPDATES: 'tool-updates',
  TURN_COMPLETE: 'turn-complete',
  PERMISSION_REQUEST: 'permission-request',
  PERMISSION_DISMISSED: 'permission-dismissed',
  HISTORY_LOAD: 'history-load',
  STATUS_UPDATE: 'status-update',
  MODE_UPDATED: 'mode-updated',
  COMPACTING: 'compacting',
  COMPACT_DONE: 'compact-done',
  SESSION_ERROR: 'session-error',
  SESSION_STATE: 'session-state',
  SESSION_ENDED: 'session-ended',
  CLIENT_ID: 'client-id',
  PENDING_NOTIFICATIONS: 'pending-notifications',
  ERROR: 'error',
  // Interactive Prompts (unified permission/question/plan overlay)
  INTERACTIVE_PROMPT: 'interactive-prompt',
  PROMPT_RESPONSE: 'prompt-response',
  PROMPT_DISMISSED: 'prompt-dismissed',
  // Cross-AI Review
  REVIEW_STARTED: 'review-started',
  REVIEW_ENDED: 'review-ended',
} as const;

/**
 * CLI plan approval selector option indices (ExitPlanMode).
 * Claude Code v2.1.x shows 3 options:
 *   0: "Yes, auto-accept edits"         → BYPASS
 *   1: "Yes, manually approve edits"    → MANUALLY_APPROVE
 *   2: "Type here to tell Claude what to change" → TEXT_FEEDBACK
 */
export const PLAN_OPTION = {
  BYPASS: 0,
  MANUALLY_APPROVE: 1,
  TEXT_FEEDBACK: 2,
} as const;
