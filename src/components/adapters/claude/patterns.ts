import type { TextPattern } from '@/lib/text-transforms';

/**
 * Claude Code text patterns for special content rendering.
 *
 * Insight format:
 *   `★ Insight ─────────────────────────────────────`
 *   [content lines]
 *   `─────────────────────────────────────────────────`
 */
export const CLAUDE_PATTERNS: TextPattern[] = [
  {
    type: 'insight',
    regex: /`[★✦]?\s*Insight\s*[─\-]+`\n([\s\S]*?)\n`[─\-]+[.。]?`/g,
  },
];
