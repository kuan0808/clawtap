# InsightBlock — Adapter-Specific Content Rendering

## Problem

Claude Code produces "Insight" blocks in its markdown responses:

```
`★ Insight ─────────────────────────────────────`
[educational content]
`─────────────────────────────────────────────────`
```

These currently render as ugly inline `<code>` elements in ReactMarkdown. Need a dedicated, collapsible UI component — while keeping the architecture extensible for other adapters (Gemini, Codex) that may have their own text patterns.

## Design

### Approach: Frontend Text Transform with Adapter-Scoped Patterns

- **No server changes.** The Insight text flows through the existing pipeline as `{ type: 'text' }` content blocks.
- **Regex patterns** defined per-adapter in adapter-scoped files.
- **Generic splitter** in `src/lib/` accepts patterns as parameters — no coupling to any specific adapter.
- **Collapsible card UI** matching ToolCallCard's expand/collapse pattern.

### File Structure

```
src/
├── lib/
│   └── text-transforms.ts                  # Generic: splitTextSegments(text, patterns)
├── components/
│   ├── adapters/
│   │   └── claude/
│   │       ├── InsightBlock.tsx             # Collapsible insight card
│   │       └── patterns.ts                 # INSIGHT_RE regex + segment type
│   ├── MessageBubble.tsx                   # Modified: split → map → render
│   └── ...
```

**Dependency direction:**
```
MessageBubble → text-transforms (generic)
MessageBubble → adapters/claude/patterns (adapter-specific)
MessageBubble → adapters/claude/InsightBlock (adapter-specific)
```

Generic code never imports adapter-specific code. MessageBubble is the composition root.

### `src/components/adapters/claude/patterns.ts`

Exports Claude-specific text patterns:

```typescript
import type { TextPattern } from '@/lib/text-transforms';

export const CLAUDE_PATTERNS: TextPattern[] = [
  {
    type: 'insight',
    regex: /`[★✦]?\s*Insight[─\-\s]*`\n([\s\S]*?)\n`[─\-]+[.。]?`/g,
  },
];
```

### `src/lib/text-transforms.ts`

Generic segment splitter — adapter-agnostic:

```typescript
export interface TextPattern {
  type: string;
  regex: RegExp;
}

export type TextSegment = {
  type: string;  // 'markdown' | 'insight' | future types
  text: string;
};

export function splitTextSegments(text: string, patterns: TextPattern[]): TextSegment[] {
  // Fast path: no patterns or no text → return as-is
  // For each pattern, find all matches and record their positions
  // Split text into alternating markdown/matched segments
  // Streaming safety: unmatched opening fence → treat as plain markdown
}
```

### `src/components/adapters/claude/InsightBlock.tsx`

Collapsible card — Style C from brainstorming:

- **Collapsed (default):** `★` icon + "Insight" label + first-line summary (truncated) + `▼` chevron
- **Expanded:** Full content rendered via ReactMarkdown with prose styling
- **Visual:** `bg-surface/30 border border-border/50 rounded-lg` — subtle card with accent star

### `src/components/MessageBubble.tsx` Changes

```diff
+ import { splitTextSegments } from '@/lib/text-transforms';
+ import { CLAUDE_PATTERNS } from './adapters/claude/patterns';
+ import { InsightBlock } from './adapters/claude/InsightBlock';

  // In assistant message render:
  const textContent = content.filter(...).map(...).join('');
+ const segments = splitTextSegments(textContent, CLAUDE_PATTERNS);

- <ReactMarkdown ...>{textContent}</ReactMarkdown>
+ {segments.map((seg, i) =>
+   seg.type === 'insight'
+     ? <InsightBlock key={i} text={seg.text} />
+     : <ReactMarkdown key={i} components={markdownComponents}>{seg.text}</ReactMarkdown>
+ )}
```

## Extensibility

When Gemini adds "Analysis" blocks:

1. `src/components/adapters/gemini/patterns.ts` — export `GEMINI_PATTERNS`
2. `src/components/adapters/gemini/AnalysisBlock.tsx` — new component
3. `MessageBubble.tsx` — merge patterns: `[...CLAUDE_PATTERNS, ...GEMINI_PATTERNS]`
4. Add one more segment type case in the render map

No server changes. No refactoring. Explicit additions only.

## Edge Cases

- **Streaming:** Partial insight (opening fence without closing) → `splitTextSegments` treats as plain markdown. InsightBlock only renders when both fences are present.
- **No insights:** Fast path — `splitTextSegments` returns `[{ type: 'markdown', text }]`, single ReactMarkdown render. No performance regression.
- **Multiple insights:** Each becomes its own InsightBlock in the segments array, with markdown segments between them.
- **Nested markdown in insight body:** ReactMarkdown inside InsightBlock handles bullet points, code, links.

## Not Changing

- Server pipeline (TranscriptParser, session-manager, IAdapter)
- ChatView.tsx (Insight is text-layer, not content-block-layer)
- useChat.ts
- WS protocol
