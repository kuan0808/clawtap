/** A content block within a Codex message */
export interface CodexContentBlock {
  type: 'input_text' | 'output_text' | 'input_image' | string;
  text?: string;
  image?: { url: string };
  [key: string]: unknown;
}

/** Standard normalized content block (matches claw-tap frontend format) */
export interface NormalizedBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

const SYSTEM_PATTERNS: RegExp[] = [
  /<permissions instructions>/i,
  /<environment_context>/i,
  /AGENTS\.md/,
];

/**
 * Convert a Codex content block to the standard format used by claw-tap.
 *
 * - `input_text`  → `{ type: 'text', text }`
 * - `output_text` → `{ type: 'text', text }`
 * - Unknown types are passed through as-is.
 */
export function normalizeContentBlock(block: CodexContentBlock): NormalizedBlock {
  if (block.type === 'input_text' || block.type === 'output_text') {
    return { type: 'text', text: block.text };
  }
  return { ...block } as NormalizedBlock;
}

/**
 * Extract readable text from an array of Codex content blocks.
 * Concatenates all text-bearing blocks (input_text / output_text) with newlines.
 */
export function extractText(content: CodexContentBlock[]): string {
  return content
    .filter((b) => b.type === 'input_text' || b.type === 'output_text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/**
 * Return true if this message should be filtered out as a system message.
 *
 * Matches:
 * - `role === 'developer'`
 * - Text containing `<permissions instructions>`, `<environment_context>`, or `AGENTS.md`
 */
export function isSystemMessage(role: string, content: CodexContentBlock[]): boolean {
  if (role === 'developer') return true;

  const text = extractText(content);
  for (const pattern of SYSTEM_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}
