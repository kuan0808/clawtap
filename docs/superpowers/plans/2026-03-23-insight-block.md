# InsightBlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Claude Code's Insight blocks as collapsible cards instead of ugly inline code elements.

**Architecture:** Frontend-only text transform. A generic segment splitter in `src/lib/` accepts adapter-scoped regex patterns. Claude-specific patterns and UI live in `src/components/adapters/claude/`. MessageBubble splits text into segments and renders InsightBlocks for matched segments. No server changes.

**Tech Stack:** React, ReactMarkdown, TypeScript, Tailwind CSS, lucide-react icons

---

### Task 1: Generic Text Segment Splitter

**Files:**
- Create: `src/lib/text-transforms.ts`

- [ ] **Step 1: Create the text-transforms module**

```typescript
// src/lib/text-transforms.ts

export interface TextPattern {
  type: string;
  regex: RegExp;
}

export interface TextSegment {
  type: string;
  text: string;
}

/**
 * Split text into typed segments based on regex patterns.
 * Unmatched regions become { type: 'markdown' } segments.
 * Fast path: returns single markdown segment when no patterns match.
 */
export function splitTextSegments(text: string, patterns: TextPattern[]): TextSegment[] {
  if (!text || patterns.length === 0) return [{ type: 'markdown', text }];

  // Collect all matches from all patterns with their positions
  const matches: { type: string; start: number; end: number; captured: string }[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        start: m.index,
        end: m.index + m[0].length,
        captured: m[1] ?? m[0],
      });
    }
  }

  if (matches.length === 0) return [{ type: 'markdown', text }];

  matches.sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      const before = text.slice(cursor, match.start).trim();
      if (before) segments.push({ type: 'markdown', text: before });
    }
    segments.push({ type: match.type, text: match.captured.trim() });
    cursor = match.end;
  }

  if (cursor < text.length) {
    const after = text.slice(cursor).trim();
    if (after) segments.push({ type: 'markdown', text: after });
  }

  return segments;
}
```

- [ ] **Step 2: Verify build passes**

- [ ] **Step 3: Commit**

---

### Task 2: Claude Adapter Patterns

**Files:**
- Create: `src/components/adapters/claude/patterns.ts`

- [ ] **Step 1: Create Claude patterns module**

```typescript
// src/components/adapters/claude/patterns.ts
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
```

- [ ] **Step 2: Verify build passes**

- [ ] **Step 3: Commit**

---

### Task 3: InsightBlock Collapsible Component

**Files:**
- Create: `src/components/adapters/claude/InsightBlock.tsx`

**Reference:** Follow `src/components/ToolCallCard.tsx` expand/collapse pattern (useState, ChevronDown/Up icons).

- [ ] **Step 1: Create InsightBlock component**

```tsx
// src/components/adapters/claude/InsightBlock.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

export function InsightBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const summary = text.split('\n').find(l => l.trim())?.trim() || 'Insight';
  const truncated = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full text-left px-3 py-2 transition-colors',
          'bg-surface/30 border border-border/50 hover:bg-surface/60',
          expanded ? 'rounded-t-lg' : 'rounded-lg',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-accent-light text-sm shrink-0">★</span>
          <span className="text-xs text-accent-light font-medium shrink-0">Insight</span>
          {!expanded && (
            <span className="text-xs text-text-dim truncate flex-1">{truncated}</span>
          )}
          {expanded
            ? <ChevronUp className="size-3.5 text-text-dim shrink-0 ml-auto" />
            : <ChevronDown className="size-3.5 text-text-dim shrink-0 ml-auto" />
          }
        </div>
      </button>
      {expanded && (
        <div className={cn(
          'bg-surface/20 border border-t-0 border-border/50 rounded-b-lg px-3 py-2',
          'prose prose-invert prose-sm max-w-none',
          '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5',
          '[&_code]:text-accent-light [&_code]:text-xs',
        )}>
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

- [ ] **Step 3: Commit**

---

### Task 4: Integrate into MessageBubble

**Files:**
- Modify: `src/components/MessageBubble.tsx`

- [ ] **Step 1: Add imports and segment splitting**

Add imports at top of file:
```typescript
import { splitTextSegments } from '@/lib/text-transforms';
import { CLAUDE_PATTERNS } from './adapters/claude/patterns';
import { InsightBlock } from './adapters/claude/InsightBlock';
```

In the assistant message render block, replace lines 64-66:

Before:
```tsx
<ReactMarkdown components={markdownComponents}>
  {textContent}
</ReactMarkdown>
```

After:
```tsx
{(() => {
  const segments = splitTextSegments(textContent, CLAUDE_PATTERNS);
  return segments.map((seg, i) =>
    seg.type === 'insight'
      ? <InsightBlock key={i} text={seg.text} />
      : <ReactMarkdown key={i} components={markdownComponents}>{seg.text}</ReactMarkdown>
  );
})()}
```

- [ ] **Step 2: Verify build passes**

- [ ] **Step 3: Manual verification**

1. Start server: `CLAUDE_UI_PASSWORD=test npx tsx server/index.ts`
2. Open app, find or create a session with an Insight block
3. Verify: collapsed card with ★ label, expand/collapse works, surrounding markdown intact, messages without insights unaffected

- [ ] **Step 4: Commit**

---

### Task 5: E2E Test Specs

**Files:**
- Modify: `tests/e2e-spec.feature`
- Modify: `tests/e2e-progress.md`

- [ ] **Step 1: Add E2E scenarios to e2e-spec.feature**

Append to the end of the file:

```gherkin
# =============================================================================
# Feature: Insight Block Rendering
# =============================================================================

Feature: Insight Block Display

  Scenario: Insight block renders as collapsible card
    Given I have an active chat session with an Insight block in the response
    Then the Insight block shows as a collapsed card
    And the card shows "★ Insight" label with a summary
    And a chevron icon is visible

  Scenario: Insight block expands on tap
    Given I see a collapsed Insight card
    When I tap the Insight card
    Then the card expands to show full markdown content
    And the chevron changes to up arrow

  Scenario: Insight block collapses on second tap
    Given I see an expanded Insight card
    When I tap the Insight card again
    Then the card collapses back to summary view

  Scenario: Multiple Insight blocks in one message
    Given I have a response with two Insight blocks separated by text
    Then both render as separate collapsible cards
    And the text between them renders as normal markdown

  Scenario: Message without Insight blocks renders normally
    Given I have a response with no Insight delimiters
    Then the message renders as plain markdown

  Scenario: Insight block in reconnected session history
    Given I reconnect to a session that had Insight blocks
    Then the Insight blocks render correctly as collapsible cards
```

- [ ] **Step 2: Add progress entries to e2e-progress.md**

Add at end of Progress section:

```markdown
### Feature 54: Insight Block Display — NOT STARTED (0/6)
Scenarios:
- [ ] Insight block renders as collapsible card
- [ ] Insight block expands on tap
- [ ] Insight block collapses on second tap
- [ ] Multiple Insight blocks in one message
- [ ] Message without Insight blocks renders normally
- [ ] Insight block in reconnected session history
```

- [ ] **Step 3: Commit**
