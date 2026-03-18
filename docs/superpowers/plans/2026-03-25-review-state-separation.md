# Review State Separation + Session List Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate active review and history review states so viewing historical reviews doesn't conflict with active reviews, fix marker in session list, hide child sessions from session list.

**Spec:** `docs/superpowers/specs/2026-03-25-review-state-separation-design.md`

---

### Task 1: Separate activeReview and historyReview states

**Files:**
- `src/hooks/useChat.ts`
- `src/components/ChatView.tsx`
- `src/components/FloatingReviewPanel.tsx`

- [ ] **Step 1: Add `historyReview` state to useChat, rename `reviewPanelState` → `activeReviewPanel`**

In `src/hooks/useChat.ts`:

Change state declarations (around line 147):
```typescript
// OLD:
const [reviewPanelState, setReviewPanelState] = useState<'expanded' | 'minimized'>('expanded');

// NEW:
const [activeReviewPanel, setActiveReviewPanel] = useState<'expanded' | 'minimized'>('expanded');
const [historyReview, setHistoryReview] = useState<any>(null);
```

Export `historyReview`, `setHistoryReview`, `activeReviewPanel`, `setActiveReviewPanel` in the return value. Remove old `reviewPanelState`, `setReviewPanelState` exports.

- [ ] **Step 2: Remove `readOnlyReview` state from ChatView**

In `src/components/ChatView.tsx`, remove:
```typescript
const [readOnlyReview, setReadOnlyReview] = useState(false);
```

Replace all `readOnlyReview` references with `!!historyReview` (from useChat).

Replace all `setReadOnlyReview(...)` calls — remove them (historyReview existence replaces the boolean).

- [ ] **Step 3: Update `handleOpenReadOnlyReview` to use `historyReview`**

Change from:
```typescript
setActiveReview({ ...review data... });
setReviewPanelState('expanded');
setReadOnlyReview(true);
```

To:
```typescript
setHistoryReview({ ...review data... });
if (activeReview) setActiveReviewPanel('minimized');  // minimize active if exists
```

- [ ] **Step 4: Update `closeReview` to clear both states**

```typescript
const closeReview = useCallback(async () => {
  if (activeReview?.reviewId) {
    try { await api.endReview(activeReview.reviewId); } catch {}
  }
  setActiveReview(null);
  setHistoryReview(null);
  setReviewInitialPrompt(null);
  setReviewCwd(null);
}, [activeReview]);
```

No more `readOnlyReview` check — `closeReview` always ends the active review.

Add a separate `closeHistoryPanel`:
```typescript
const closeHistoryPanel = useCallback(() => {
  setHistoryReview(null);
}, []);
```

- [ ] **Step 5: Update `handleReviewSelect` (start new review)**

Add: `setHistoryReview(null)` to clear any open history panel.
Change: `setReviewPanelState('expanded')` → `setActiveReviewPanel('expanded')`

- [ ] **Step 6: Update FloatingReviewPanel rendering in ChatView**

Compute panel review outside JSX (not in IIFE):

```typescript
// Near other memos/derived state
const panelReview = historyReview || (activeReviewPanel === 'expanded' ? activeReview : null);
const isHistoryPanel = !!historyReview;
```

Replace the current conditional rendering with:

```tsx
{panelReview && (
  <FloatingReviewPanel
    reviewId={panelReview.reviewId || panelReview.id || undefined}
    childSessionId={panelReview.childSessionId || panelReview.child_cli_session_id || undefined}
    childAdapter={panelReview.childAdapter || panelReview.child_adapter}
    reviewTitle={panelReview.reviewTitle || panelReview.review_title}
    onEnd={isHistoryPanel ? closeHistoryPanel : closeReview}
    onMinimize={isHistoryPanel ? undefined : () => setActiveReviewPanel('minimized')}
    readOnly={isHistoryPanel}
    initialPrompt={!isHistoryPanel ? (reviewInitialPrompt || undefined) : undefined}
    cwd={!isHistoryPanel ? (reviewCwd || undefined) : undefined}
    onSessionCreated={!isHistoryPanel ? onSessionCreatedCallback : undefined}
  />
)}
```

Note: `panelState` and `onPanelStateChange` props removed (Step 8).

- [ ] **Step 7: Update minimized bar in `renderAboveInput`**

Show minimized bar when: `activeReview && (activeReviewPanel === 'minimized' || historyReview)`

Update ▲ Expand button:
```typescript
onClick={() => { setHistoryReview(null); setActiveReviewPanel('expanded'); }}
```

The minimized bar is for the ACTIVE review only. It always shows active review info, never history info.

```
Bar shows when: activeReview !== null AND (activeReviewPanel === 'minimized' OR historyReview !== null)
Bar content: always shows activeReview info
Bar label: always "active" (not "ended")
Bar buttons: ▲ Expand (closes history + expands active) | End (ends active review)
```

Remove all `readOnlyReview` / `historyReview` checks from the bar rendering — bar is purely about active review.

- [ ] **Step 8: Update FloatingReviewPanel type — remove `panelState` prop**

Since FloatingReviewPanel is only rendered when it should be visible (expanded), the `panelState` prop is no longer needed. The parent (ChatView) controls visibility.

Remove from interface:
```typescript
panelState: 'expanded' | 'minimized';
onPanelStateChange: (state: 'expanded' | 'minimized') => void;
```

Remove the `if (panelState === 'minimized') return null;` check.

Keep the ▼ minimize button in the header — it calls a new `onMinimize` prop:
```typescript
onMinimize?: () => void;  // only for active (non-readOnly) panel
```

ChatView passes: `onMinimize={() => setActiveReviewPanel('minimized')}`

- [ ] **Step 9: Verify + commit**

```bash
npx tsc --noEmit
git add src/hooks/useChat.ts src/components/ChatView.tsx src/components/FloatingReviewPanel.tsx
git commit -m "refactor: separate activeReview and historyReview states, mutual exclusion"
```

---

### Task 2: Fix marker in session list (Codex getSessions)

**Files:**
- `server/adapters/codex/jsonl-store.ts`

- [ ] **Step 1: Strip marker in `getSessions` (line 204)**

Change:
```typescript
firstPrompt: entry.text ? entry.text.slice(0, 200) : null,
```

To:
```typescript
firstPrompt: entry.text
  ? entry.text.replace(/^\[CODETAP_REF:[^\]]+\](?:\\n|\n)?/, '').slice(0, 200)
  : null,
```

- [ ] **Step 2: Verify + commit**

```bash
npx tsc --noEmit
git add server/adapters/codex/jsonl-store.ts
git commit -m "fix: strip CODETAP_REF marker from Codex getSessions firstPrompt"
```

---

### Task 3: Hide child sessions from session list

**Files:**
- `server/index.ts`

- [ ] **Step 1: Filter child sessions from project session list**

Find the GET endpoint that returns sessions for a project (search for `getSessions` calls in `server/index.ts`). After getting the sessions array, filter out child session IDs:

```typescript
const childIds = sessionReviews.getAllChildIds();
const filtered = sessions.filter(s => !childIds.has(s.sessionId));
```

`getAllChildIds()` already exists in `server/db.ts` — it returns a `Set<string>` of child CLI session IDs. Verify it includes ALL child IDs (both active and ended reviews), not just active ones. Ended child sessions should also be hidden from the session list.

- [ ] **Step 2: Filter child sessions from active sessions list**

Find the GET endpoint for active sessions. Apply the same filter:

```typescript
const childIds = sessionReviews.getAllChildIds();
const filtered = activeSessions.filter(s => !childIds.has(s.sessionId));
```

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit
git add server/index.ts
git commit -m "fix: hide child review sessions from project and active session lists"
```

---

### Task 4: E2E Verification

- [ ] **Step 1:** Start server, create Claude session, send message
- [ ] **Step 2:** Send to Codex → verify panel opens with response
- [ ] **Step 3:** Click ▼ minimize → verify thin bar appears, parent input usable
- [ ] **Step 4:** Click ▲ expand → verify panel opens again
- [ ] **Step 5:** Click End → verify panel closes, review markers appear
- [ ] **Step 6:** Click collapsed review card → verify read-only panel opens (history)
- [ ] **Step 7:** Verify minimized bar still shows active review info (if active review exists)
- [ ] **Step 8:** Close read-only panel → verify return to normal
- [ ] **Step 9:** Check session list → verify no CODETAP_REF marker, no child sessions visible

---

## Self-Review

### State model after Task 1
```
activeReview      — ongoing review (null if none)
historyReview     — historical review being viewed (null if none)
activeReviewPanel — 'expanded' | 'minimized'

Panel: historyReview || (expanded activeReview) || nothing
Bar: activeReview && (minimized || historyReview)
```

### Mutual exclusion
- Open history → minimize active ✅
- Expand active → close history ✅
- End active → close both ✅
- Start new → close history + expand ✅

### Files changed
| File | Changes |
|------|---------|
| `src/hooks/useChat.ts` | Add historyReview state, rename reviewPanelState → activeReviewPanel |
| `src/components/ChatView.tsx` | Remove readOnlyReview, use historyReview, update closeReview/bar/panel rendering |
| `src/components/FloatingReviewPanel.tsx` | Remove panelState prop, add onMinimize |
| `server/adapters/codex/jsonl-store.ts` | Strip marker in getSessions |
| `server/index.ts` | Filter child sessions from session/active lists |
