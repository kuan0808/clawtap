import { extractText, isSystemMessage, extractPlanContent, isNoResponseMessage, extractSubTools } from './message-utils.js';
import type { JsonlEntry, ContentBlock, SubToolBlock } from './message-utils.js';

/** Pending tool tracking entry */
export interface PendingTool {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result: ContentBlock | null;
  parentToolUseId?: string;
}

/** Parsed message from transcript */
export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'plan';
  content: ContentBlock[] | string;
  senderClientId?: string | null;
  adapter?: string;
}

/** Result of parse() */
export interface ParseResult {
  messages: ParsedMessage[];
  interrupted: boolean;
}

export class TranscriptParser {
  pendingTools: Map<string, PendingTool>; // tool_use_id → { name, input, status }
  private _pendingSubTools: Map<string, SubToolBlock[]>; // parentToolUseId → [tool_use blocks with parent_tool_use_id]
  private _msgIndex: number = 0;

  constructor() {
    this.pendingTools = new Map();
    this._pendingSubTools = new Map();
  }

  /**
   * Parse new JSONL entries into frontend-ready messages.
   * Only processes user/assistant type entries.
   * Returns array of { role, content, tools? }
   */
  parse(entries: JsonlEntry[]): ParseResult {
    // NOTE: Do NOT reset _msgIndex here — parse() is called incrementally via
    // watcher.onNewEntries(). Resetting would restart IDs at msg-0, causing
    // React key collisions. _msgIndex accumulates across incremental batches.
    const messages: ParsedMessage[] = [];
    let interrupted = false;

    for (const entry of entries) {
      // Process agent_progress entries for sub-tool tracking
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress') {
        this._processAgentProgress(entry);
        continue;
      }

      if (!entry.message) continue;

      // Detect user interruption marker
      if (!interrupted && entry.type === 'user') {
        const text = extractText(entry.message.content);
        if (text.includes('[Request interrupted by user')) {
          interrupted = true;
        }
      }

      if (entry.type === 'user') {
        const msg = this._parseUserEntry(entry);
        if (msg) messages.push(msg);
      } else if (entry.type === 'assistant') {
        const msg = this._parseAssistantEntry(entry);
        if (msg) messages.push(msg);
      }
    }

    // Inject accumulated sub-tool blocks into assistant messages containing their parent Agent tool
    // This handles history load and same-batch scenarios where Agent + progress arrive together
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        const subTools = this._pendingSubTools.get(block.id!);
        if (subTools && subTools.length > 0) {
          (msg.content as ContentBlock[]).push(...(subTools as unknown as ContentBlock[]));
          this._pendingSubTools.delete(block.id!);
        }
      }
    }

    return { messages, interrupted };
  }

  /** Get current pending tool statuses (only running tools — completed sub-tools are excluded) */
  getPendingTools(): Map<string, PendingTool> {
    const filtered = new Map<string, PendingTool>();
    for (const [id, tool] of this.pendingTools) {
      if (tool.status === 'running') filtered.set(id, tool);
    }
    return filtered;
  }

  private _parseUserEntry(entry: JsonlEntry): ParsedMessage | null {
    const content = entry.message!.content;
    const text = extractText(content);

    // Skip system/CLI messages
    if (isSystemMessage(text, content)) return null;

    // "Implement the following plan:" → plan type
    const planBody = extractPlanContent(text);
    if (planBody !== null) {
      return { id: `msg-${this._msgIndex++}`, role: 'plan', content: planBody, adapter: 'claude' };
    }

    // Process tool_result blocks (pair with pending tool_use)
    if (Array.isArray(content)) {
      let hasToolResult = false;
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          hasToolResult = true;
          const pending = this.pendingTools.get(block.tool_use_id);
          if (pending) {
            pending.status = block.is_error ? 'error' : 'success';
            pending.result = block;
            this.pendingTools.delete(block.tool_use_id);
          }
        }
      }
      // If message is ONLY tool results, don't emit as chat message
      if (hasToolResult && !text.trim()) return null;
    }

    // Normal user message — normalize content to array format
    const userContent: ContentBlock[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [{ type: 'text', text: String(content) }];
    return { id: `msg-${this._msgIndex++}`, role: 'user', content: userContent, adapter: 'claude' };
  }

  private _parseAssistantEntry(entry: JsonlEntry): ParsedMessage | null {
    const content = entry.message?.content || entry.content;
    if (!content) return null;

    // Track pending tool_use blocks
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'tool_use') {
          this.pendingTools.set(block.id!, {
            toolUseId: block.id!,
            name: block.name!,
            input: block.input as Record<string, unknown>,
            status: 'running',
            result: null,
          });
        }
      }
    }

    // Skip "No response requested" type messages
    const text = extractText(content);
    if (isNoResponseMessage(text)) return null;

    // Return content array directly (not the message wrapper)
    const asstContent: ContentBlock[] = Array.isArray(content) ? content as ContentBlock[] : [{ type: 'text', text: String(content) }];
    return { id: `msg-${this._msgIndex++}`, role: 'assistant', content: asstContent, adapter: 'claude' };
  }

  private _processAgentProgress(entry: JsonlEntry): void {
    const result = extractSubTools(entry);
    if (result) {
      for (const subTool of result.subTools) {
        // Track in pendingTools with parent reference
        this.pendingTools.set(subTool.id, {
          toolUseId: subTool.id, name: subTool.name, input: subTool.input,
          status: 'running', result: null, parentToolUseId: result.parentId,
        });
      }
      // Accumulate for injection into parent message content (same-batch / history)
      if (!this._pendingSubTools.has(result.parentId)) this._pendingSubTools.set(result.parentId, []);
      this._pendingSubTools.get(result.parentId)!.push(...result.subTools);
    }

    // Process tool_result entries (update status of pending sub-tools)
    const msg = entry.data?.message?.message;
    if (msg?.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const pending = this.pendingTools.get(block.tool_use_id);
        if (pending) {
          pending.status = block.is_error ? 'error' : 'success';
          pending.result = block;
        }
      }
    }
  }

}
