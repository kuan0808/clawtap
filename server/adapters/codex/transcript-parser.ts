import {
  normalizeContentBlock,
  extractText,
  isSystemMessage,
} from './message-utils.js';
import type { CodexContentBlock, NormalizedBlock } from './message-utils.js';
import type { ChatMessage, MessageContent } from '../../types/messages.js';

// ---------------------------------------------------------------------------
// Codex JSONL entry shape
// ---------------------------------------------------------------------------

export interface CodexJsonlEntry {
  timestamp: string; // ISO 8601
  type:
    | 'session_meta'
    | 'response_item'
    | 'event_msg'
    | 'turn_context'
    | 'compacted';
  payload: any;
}

// ---------------------------------------------------------------------------
// Pending tool tracking
// ---------------------------------------------------------------------------

export interface PendingTool {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result: string | null;
}

// ---------------------------------------------------------------------------
// Parse result types
// ---------------------------------------------------------------------------

export interface ToolStartEvent {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolDoneEvent {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
}

export interface StatusUpdate {
  contextPercent: number | null;
  model: string | null;
  cost: number | null;
}

export interface ProcessResult {
  messages: ChatMessage[];
  toolStarts: ToolStartEvent[];
  toolDones: ToolDoneEvent[];
  statusUpdate: StatusUpdate | null;
  toolUpdates: Record<string, any> | null;
  turnComplete: boolean;   // true when task_complete or turn_aborted is seen
}

// ---------------------------------------------------------------------------
// CodexTranscriptParser
// ---------------------------------------------------------------------------

export class CodexTranscriptParser {
  pendingTools: Map<string, PendingTool>;
  private _model: string | null;
  private _msgIndex: number = 0;

  constructor() {
    this.pendingTools = new Map();
    this._model = null;
  }

  /**
   * Process new JSONL entries into frontend-ready events.
   *
   * Returns messages, tool lifecycle events, and status updates.
   */
  processNewEntries(entries: CodexJsonlEntry[]): ProcessResult {
    const messages: ChatMessage[] = [];
    const toolStarts: ToolStartEvent[] = [];
    const toolDones: ToolDoneEvent[] = [];
    let statusUpdate: StatusUpdate | null = null;
    let turnComplete = false;

    for (const entry of entries) {
      switch (entry.type) {
        case 'response_item':
          this._processResponseItem(entry.payload, messages, toolStarts, toolDones);
          break;

        case 'event_msg': {
          const result = this._processEventMsg(entry.payload, statusUpdate);
          statusUpdate = result.status;
          if (result.turnComplete) turnComplete = true;
          break;
        }

        case 'turn_context':
          if (entry.payload?.model) {
            this._model = entry.payload.model;
            // Ensure statusUpdate reflects the newly-seen model
            if (!statusUpdate) {
              statusUpdate = { contextPercent: null, model: this._model, cost: null };
            } else {
              statusUpdate.model = this._model;
            }
          }
          break;

        case 'session_meta':
        case 'compacted':
          // Skip — metadata / compaction markers
          break;
      }
    }

    // Build toolUpdates map if any pending tools changed
    let toolUpdates: Record<string, any> | null = null;
    if (toolStarts.length > 0 || toolDones.length > 0) {
      const running = this.getPendingTools();
      if (running.size > 0) {
        toolUpdates = Object.fromEntries(running);
      }
    }

    return { messages, toolStarts, toolDones, statusUpdate, toolUpdates, turnComplete };
  }

  /**
   * Parse entries for history view — returns only messages (with tool blocks inlined).
   */
  parseForHistory(entries: CodexJsonlEntry[]): ChatMessage[] {
    this._msgIndex = 0;
    const messages: ChatMessage[] = [];

    for (const entry of entries) {
      if (entry.type !== 'response_item') continue;

      const payload = entry.payload;
      if (!payload) continue;

      const itemType = payload.type;

      if (itemType === 'message') {
        const role = payload.role;
        if (role === 'developer') continue;

        const content = Array.isArray(payload.content) ? payload.content : [];

        if (role === 'user') {
          if (isSystemMessage(role, content)) continue;
          const normalized = this._normalizeContentBlocks(content);
          if (normalized.length > 0) {
            messages.push({ id: `msg-${this._msgIndex++}`, role: 'user', content: normalized, adapter: 'codex' });
          }
        } else if (role === 'assistant') {
          const normalized = this._normalizeContentBlocks(content);
          if (normalized.length > 0) {
            messages.push({ id: `msg-${this._msgIndex++}`, role: 'assistant', content: normalized, adapter: 'codex' });
          }
        }
      } else if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        // Inline as tool_use block in the last assistant message, or create one
        const toolBlock: MessageContent = {
          type: 'tool_use',
          id: payload.call_id || '',
          name: payload.name || 'unknown',
          input: this._safeParseInput(payload.arguments || payload.input),
        };
        this._appendToLastAssistant(messages, toolBlock);
      } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        // Inline as tool_result block
        const resultBlock: MessageContent = {
          type: 'tool_result',
          tool_use_id: payload.call_id || '',
          content: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? ''),
        };
        this._appendToLastAssistant(messages, resultBlock);
      }
      // reasoning, web_search_call — skip for history
    }

    return messages;
  }

  /** Return only tools with status 'running'. */
  getPendingTools(): Map<string, PendingTool> {
    const filtered = new Map<string, PendingTool>();
    for (const [id, tool] of this.pendingTools) {
      if (tool.status === 'running') filtered.set(id, tool);
    }
    return filtered;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _processResponseItem(
    payload: any,
    messages: ChatMessage[],
    toolStarts: ToolStartEvent[],
    toolDones: ToolDoneEvent[],
  ): void {
    if (!payload) return;

    const itemType = payload.type;

    switch (itemType) {
      case 'message':
        this._processMessage(payload, messages);
        break;

      case 'function_call':
      case 'custom_tool_call':
        this._processToolCall(payload, toolStarts);
        break;

      case 'function_call_output':
      case 'custom_tool_call_output':
        this._processToolOutput(payload, toolDones);
        break;

      case 'reasoning':
      case 'web_search_call':
        // Skip
        break;
    }
  }

  private _processMessage(payload: any, messages: ChatMessage[]): void {
    const role = payload.role;
    const content: CodexContentBlock[] = Array.isArray(payload.content) ? payload.content : [];

    if (role === 'developer') return;

    if (role === 'user') {
      if (isSystemMessage(role, content)) return;
      const normalized = this._normalizeContentBlocks(content);
      if (normalized.length > 0) {
        messages.push({ id: `msg-${this._msgIndex++}`, role: 'user', content: normalized, adapter: 'codex' });
      }
      return;
    }

    if (role === 'assistant') {
      const normalized = this._normalizeContentBlocks(content);
      if (normalized.length > 0) {
        messages.push({ id: `msg-${this._msgIndex++}`, role: 'assistant', content: normalized, adapter: 'codex' });
      }
    }
  }

  private _processToolCall(payload: any, toolStarts: ToolStartEvent[]): void {
    const callId = payload.call_id || '';
    const name = payload.name || 'unknown';
    const input = this._safeParseInput(payload.arguments || payload.input);

    // Track as pending
    this.pendingTools.set(callId, {
      toolUseId: callId,
      name,
      input,
      status: 'running',
      result: null,
    });

    toolStarts.push({ toolId: callId, toolName: name, input });
  }

  private _processToolOutput(payload: any, toolDones: ToolDoneEvent[]): void {
    const callId = payload.call_id || '';
    const output = typeof payload.output === 'string'
      ? payload.output
      : JSON.stringify(payload.output ?? '');

    const pending = this.pendingTools.get(callId);
    if (pending) {
      pending.status = 'success';
      pending.result = output;
      this.pendingTools.delete(callId);
    }

    toolDones.push({
      toolId: callId,
      toolName: pending?.name || 'unknown',
      input: pending?.input || {},
      result: output,
    });
  }

  private _processEventMsg(
    payload: any,
    current: StatusUpdate | null,
  ): { status: StatusUpdate | null; turnComplete: boolean } {
    if (!payload) return { status: current, turnComplete: false };

    if (payload.type === 'token_count') {
      const contextPercent = payload.rate_limits?.primary?.used_percent ?? null;
      const status: StatusUpdate = {
        contextPercent: contextPercent != null ? Math.round(contextPercent) : null,
        model: this._model,
        cost: null,
      };
      return { status, turnComplete: false };
    }

    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      return { status: current, turnComplete: true };
    }

    // agent_message, task_started — skip
    return { status: current, turnComplete: false };
  }

  /**
   * Normalize Codex content blocks to the standard MessageContent format.
   */
  private _normalizeContentBlocks(blocks: CodexContentBlock[]): MessageContent[] {
    const result: MessageContent[] = [];
    for (const block of blocks) {
      const normalized = normalizeContentBlock(block);
      // Only include blocks that carry meaningful content
      if (normalized.type === 'text' && normalized.text != null) {
        result.push({ type: 'text', text: normalized.text });
      } else if (normalized.type === 'tool_use') {
        result.push({
          type: 'tool_use',
          id: (normalized as any).id || '',
          name: (normalized as any).name || 'unknown',
          input: (normalized as any).input || {},
        });
      } else if (normalized.type === 'tool_result') {
        result.push({
          type: 'tool_result',
          tool_use_id: (normalized as any).tool_use_id || '',
          content: typeof (normalized as any).content === 'string'
            ? (normalized as any).content
            : JSON.stringify((normalized as any).content ?? ''),
        });
      }
      // Other block types (input_image, etc.) can be added later
    }
    return result;
  }

  /**
   * Safely parse a tool input that may be a JSON string or already an object.
   */
  private _safeParseInput(input: unknown): Record<string, unknown> {
    if (input == null) return {};
    if (typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {}
    }
    return { _raw: input };
  }

  /**
   * Append a content block to the last assistant message, creating one if needed.
   * Used by parseForHistory to inline tool_use / tool_result blocks.
   */
  private _appendToLastAssistant(messages: ChatMessage[], block: MessageContent): void {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (last && last.role === 'assistant') {
      last.content.push(block);
    } else {
      // Create a new assistant message to hold this block
      messages.push({ id: `msg-${this._msgIndex++}`, role: 'assistant', content: [block], adapter: 'codex' });
    }
  }
}
