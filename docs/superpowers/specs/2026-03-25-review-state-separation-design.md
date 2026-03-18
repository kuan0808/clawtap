# Review State Separation + Session List Cleanup

## Context

Three issues to fix together:

1. **activeReview / historyReview state conflict** — Viewing a historical review overwrites the active review state, losing its panel
2. **Session list shows CODETAP_REF marker** — firstPrompt not stripped (screenshot confirms markers visible in session list)
3. **Child sessions visible in session list** — review child sessions should not appear in project session list or active sessions

## A. Separate activeReview and historyReview States

### Problem
`activeReview` state serves double duty (active + read-only viewing). Viewing history replaces active review.

### Design

**State model:**
```typescript
activeReview: ReviewInfo | null        // ongoing active review
historyReview: ReviewInfo | null       // historical review being viewed (read-only)
activeReviewPanel: 'expanded' | 'minimized'  // renamed from reviewPanelState
```

**Remove:** `readOnlyReview: boolean` — replaced by `historyReview !== null`

**Panel display (mutual exclusion — only one panel at a time):**
```
historyReview !== null                       → read-only panel
activeReview && activeReviewPanel === 'expanded' → active panel
otherwise                                    → no panel
```

**Minimized bar shows when:**
```
activeReview !== null AND (activeReviewPanel === 'minimized' OR historyReview !== null)
```

**Interactions:**

| Action | Effect |
|--------|--------|
| Click collapsed card (history) | `setHistoryReview(review)` + `setActiveReviewPanel('minimized')` |
| ✕ Close history panel | `setHistoryReview(null)` |
| ▲ Expand minimized bar | `setHistoryReview(null)` + `setActiveReviewPanel('expanded')` |
| ▼ Minimize active | `setActiveReviewPanel('minimized')` |
| End active review | `setActiveReview(null)` + `setHistoryReview(null)` |
| Start new review | `setActiveReview(...)` + `setActiveReviewPanel('expanded')` + `setHistoryReview(null)` |

**FloatingReviewPanel receives:**
```typescript
const panelReview = historyReview || (activeReviewPanel === 'expanded' ? activeReview : null);
const isReadOnly = !!historyReview;

{panelReview && (
  <FloatingReviewPanel
    review={panelReview}
    readOnly={isReadOnly}
    onEnd={isReadOnly ? () => setHistoryReview(null) : closeReview}
    ...
  />
)}
```

**Files:** `src/hooks/useChat.ts`, `src/components/ChatView.tsx`, `src/components/FloatingReviewPanel.tsx`

## B. Session List Marker Strip

### Problem
Screenshot shows `[CODETAP_REF:codex-1774412730686]\nHi` in session list. The earlier fix (strip marker in `firstPrompt`) may not have been applied in all code paths, or the sessions were created before the fix.

### Design

Marker stripping is Codex-specific behavior (Codex's `sendMessage` does `\n` → `\\n` replacement). Fix in the Codex adapter only — not client-side.

**Two Codex-side locations to strip:**

1. **`codex/jsonl-store.ts` `getSessions()` line 204** — `firstPrompt` from `history.jsonl` entry. This is the session list source for ALL sessions (including historical). Strip `[CODETAP_REF:...](\\n|\n)?` from `entry.text` before slicing.

2. **`codex/codex-tmux-adapter.ts` `_processWatcherEntries()`** — `firstPrompt` for active sessions (already fixed in earlier commit, but verify it covers all paths).

**Files:** `server/adapters/codex/jsonl-store.ts`, `server/adapters/codex/codex-tmux-adapter.ts`

## C. Hide Child Sessions from Session List

### Problem
Cross-AI Review child sessions appear in the project session list and active sessions list. They should be hidden — they're child sessions owned by a parent.

### Design

**Server-side filtering:** When returning sessions (both project sessions and active sessions), exclude sessions whose ID appears as `child_cli_session_id` in the `session_reviews` table.

- `GET /api/sessions/:dir` — filter out child session IDs
- Active sessions list — filter out child session IDs from `getActiveSessions()`

**How to identify child sessions:**
- `sessionReviews.getAllChildIds()` already exists (returns Set of child CLI session IDs)
- Use this to filter in both endpoints

**Files:** `server/index.ts` (session endpoints), `server/db.ts` (getAllChildIds)

## Not Changed
- Review creation flow (already unified via QUERY)
- Send-back mechanism
- FloatingReviewPanel component structure (still uses ChatBody)
