import type { ContentBlock } from '../claude/message-utils.js';
import type { GeminiSessionMessage } from '../../stores/json-watcher.js';
import {
  extractUserText,
  extractGeminiText,
  toolCallsToContentBlocks,
} from './message-utils.js';
import type { GeminiToolCall } from './message-utils.js';

/** Parsed message ready for the frontend */
export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'plan';
  /** Always ContentBlock[] — never a plain string, for consistency with Claude/Codex */
  content: ContentBlock[];
  adapter?: string;
  senderClientId?: string | null;
}

/** Result returned by parse() */
export interface ParseResult {
  messages: ParsedMessage[];
  errors: string[];
}

/** Model/token status extracted from an info message */
export interface StatusInfo {
  model: string | null;
  tokens: Record<string, number> | null;
}

/** A single thought entry from a gemini message */
export interface ThoughtEntry {
  subject: string;
  description: string;
  timestamp: string;
}

export class GeminiTranscriptParser {
  /** Monotonically increasing message index — NOT reset between parse() calls */
  private _msgIndex: number = 0;

  /**
   * Parse an incremental batch of GeminiSessionMessages into frontend-ready ParsedMessages.
   *
   * NOTE: _msgIndex is intentionally NOT reset here. parse() is called incrementally via
   * JsonWatcher.onNewMessages(). Resetting would restart IDs at msg-0, causing React key
   * collisions across batches.
   */
  parse(messages: GeminiSessionMessage[]): ParseResult {
    const result: ParsedMessage[] = [];
    const errors: string[] = [];

    for (const msg of messages) {
      switch (msg.type) {
        case 'user': {
          const parsed = this._parseUserMessage(msg);
          if (parsed) result.push(parsed);
          break;
        }
        case 'gemini': {
          const parsed = this._parseGeminiMessage(msg);
          if (parsed) result.push(parsed);
          break;
        }
        case 'error': {
          // Collect errors to emit as session-error events; don't add as chat messages
          const errText = extractUserText(msg.content) || String(msg.content ?? 'Unknown error');
          errors.push(errText);
          break;
        }
        case 'info':
          // Info messages carry metadata (model, tokens) — skip as chat messages
          break;
        default:
          // Unknown type — skip silently
          break;
      }
    }

    return { messages: result, errors };
  }

  /**
   * Extract thought entries from a gemini message's thoughts array.
   * Returns an empty array if none are present.
   */
  static extractThoughts(msg: GeminiSessionMessage): ThoughtEntry[] {
    if (!Array.isArray(msg.thoughts) || msg.thoughts.length === 0) return [];
    return msg.thoughts
      .filter((t): t is Record<string, unknown> => t != null && typeof t === 'object')
      .map((t) => ({
        subject: typeof t['subject'] === 'string' ? t['subject'] : '',
        description: typeof t['description'] === 'string' ? t['description'] : '',
        timestamp: typeof t['timestamp'] === 'string' ? t['timestamp'] : (msg.timestamp ?? ''),
      }));
  }

  /**
   * Extract model/token status from an info-type message.
   * Returns null if the message carries no relevant status data.
   */
  static extractStatus(msg: GeminiSessionMessage): StatusInfo | null {
    const model = msg.model ?? null;
    let tokens: Record<string, number> | null = null;

    if (msg.tokens && typeof msg.tokens === 'object') {
      const raw = msg.tokens as Record<string, unknown>;
      const parsed: Record<string, number> = {};
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val === 'number') parsed[key] = val;
      }
      if (Object.keys(parsed).length > 0) tokens = parsed;
    }

    if (model === null && tokens === null) return null;
    return { model, tokens };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _parseUserMessage(msg: GeminiSessionMessage): ParsedMessage | null {
    const text = extractUserText(msg.content);
    if (!text.trim()) return null;

    const content: ContentBlock[] = [{ type: 'text', text }];
    return {
      id: `msg-${this._msgIndex++}`,
      role: 'user',
      content,
      adapter: 'gemini',
    };
  }

  private _parseGeminiMessage(msg: GeminiSessionMessage): ParsedMessage | null {
    const text = extractGeminiText(msg.content);
    const toolBlocks = this._extractToolBlocks(msg);

    // Skip completely empty messages
    if (!text.trim() && toolBlocks.length === 0) return null;

    const content: ContentBlock[] = [];

    // Text block first (if present)
    if (text.trim()) {
      content.push({ type: 'text', text });
    }

    // Tool call blocks after the text
    content.push(...toolBlocks);

    return {
      id: `msg-${this._msgIndex++}`,
      role: 'assistant',
      content,
      adapter: 'gemini',
    };
  }

  private _extractToolBlocks(msg: GeminiSessionMessage): ContentBlock[] {
    if (!Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) return [];

    const toolCalls = (msg.toolCalls as unknown[]).filter(
      (tc): tc is GeminiToolCall =>
        tc != null &&
        typeof tc === 'object' &&
        typeof (tc as Record<string, unknown>)['id'] === 'string' &&
        typeof (tc as Record<string, unknown>)['name'] === 'string',
    );

    return toolCallsToContentBlocks(toolCalls);
  }
}
