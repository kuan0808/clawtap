import type { ContentBlock } from '../claude/message-utils.js';

export type { ContentBlock };

/** A tool call embedded in a Gemini session message */
export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown[];
  status: 'running' | 'success' | 'error' | 'cancelled';
  timestamp?: string;
  displayName?: string;
  description?: string;
}

/**
 * Extract plain text from a user message's content.
 * Gemini user content is either an array of { text } objects or a plain string.
 */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { text: string } => item != null && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return '';
}

/** Alias — Gemini assistant content is always a string, but use same extractor for safety */
export const extractGeminiText = extractUserText;

/**
 * Convert Gemini's embedded toolCalls array into standard tool_use + tool_result ContentBlock pairs.
 *
 * Each GeminiToolCall becomes:
 * - A tool_use block (id, name, input = args)
 * - Optionally a tool_result block if a result is present (tool_use_id, content, is_error)
 */
export function toolCallsToContentBlocks(toolCalls: GeminiToolCall[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const tc of toolCalls) {
    // tool_use block
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.args,
    });

    // tool_result block — only if result data is present
    if (tc.result !== undefined && tc.result !== null) {
      const isError = tc.status === 'error' || tc.status === 'cancelled';

      // Extract the output or error string from the function response structure
      let resultContent = '';
      if (Array.isArray(tc.result) && tc.result.length > 0) {
        const firstResult = tc.result[0] as Record<string, unknown> | null;
        const functionResponse = firstResult?.functionResponse as Record<string, unknown> | undefined;
        const response = functionResponse?.response as Record<string, unknown> | undefined;
        if (isError) {
          resultContent = typeof response?.error === 'string'
            ? response.error
            : JSON.stringify(response?.error ?? '');
        } else {
          resultContent = typeof response?.output === 'string'
            ? response.output
            : JSON.stringify(response?.output ?? '');
        }
      }

      blocks.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: resultContent,
        is_error: isError,
      });
    }
  }

  return blocks;
}
