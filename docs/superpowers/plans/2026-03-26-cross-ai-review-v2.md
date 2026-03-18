# Cross-AI Review v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix review-ended marker position, support multi-review with tabbed panel UI, and improve send-to UX when active reviews exist.

**Architecture:** Convert `activeReview` (single object) to `activeReviews` (array) throughout useChat and ChatView. Split review markers into start-anchor and end-anchor maps. Add "send to existing review" path in the send-to flow. Refactor FloatingReviewPanel to render tabs for multiple reviews with independent useChat hooks per tab.

**Tech Stack:** React, TypeScript, SQLite (better-sqlite3), WebSocket, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-26-cross-ai-review-v2-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/db.ts` | Modify | Add `end_anchor_message_id` column, update `endReview()` signature |
| `server/index.ts` | Modify | Pass `endAnchorMessageId` to `endReview()` from DELETE handler |
| `src/hooks/useChat.ts` | Modify | `activeReview` → `activeReviews` (array), update WS handlers |
| `src/components/ChatView.tsx` | Modify | Split marker maps, new send-to-existing flow, multi-review state wiring |
| `src/components/FloatingReviewPanel.tsx` | Modify → Rename to `ReviewPanelManager.tsx` | Manage array of child chats, render tabs, minimize/expand |
| `src/components/ReviewActionMenu.tsx` | Modify | Add "send to existing review" options when active reviews exist |
| `src/components/SendToExistingSheet.tsx` | Create | Simple bottom sheet for "send to active review" quick action |
| `src/index.css` | Modify | Add review panel textarea font-size override |
| `src/lib/api.ts` | Modify | Update `endReview()` to accept `endAnchorMessageId` param |

---

### Task 1: DB Schema — Add `end_anchor_message_id` Column

**Files:**
- Modify: `server/db.ts:48-60` (CREATE TABLE), `server/db.ts:206-218` (SessionReviewRow type), `server/db.ts:325-328` (endReview method)

- [ ] **Step 1: Add column to CREATE TABLE**

In `server/db.ts`, add `end_anchor_message_id TEXT DEFAULT NULL` after the `ended_at` line in the CREATE TABLE statement (around line 59):

```sql
ended_at TEXT DEFAULT NULL,
end_anchor_message_id TEXT DEFAULT NULL
```

- [ ] **Step 2: Update SessionReviewRow type**

In the `SessionReviewRow` interface (around line 206), add:

```typescript
end_anchor_message_id: string | null;
```

- [ ] **Step 3: Update endReview() to accept endAnchorMessageId**

Replace the `endReview` method (lines 325-328) with:

```typescript
endReview(id: string, messageCount = 0, endAnchorMessageId?: string): void {
  this.db.prepare(
    `UPDATE session_reviews SET ended_at = datetime('now'), message_count = ?, end_anchor_message_id = ? WHERE id = ?`
  ).run(messageCount, endAnchorMessageId || null, id);
}
```

- [ ] **Step 4: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep db.ts`
Expected: No errors in db.ts

- [ ] **Step 5: Commit**

```bash
git add server/db.ts
git commit -m "feat(db): add end_anchor_message_id to session_reviews"
```

---

### Task 2: Server API — Pass endAnchorMessageId on Review End

**Files:**
- Modify: `server/index.ts:284-308` (DELETE /api/reviews/:id)

- [ ] **Step 1: Update DELETE handler to accept endAnchorMessageId from request body**

In `server/index.ts`, update the DELETE endpoint (around line 284). Express DELETE can have a body. Read `endAnchorMessageId` from `req.body`:

```typescript
app.delete('/api/reviews/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const review = sessionReviews.getById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const { endAnchorMessageId } = req.body || {};
    sessionReviews.endReview(review.id, 0, endAnchorMessageId);

    broadcastReviewEnded(review.parent_cli_session_id, review.id);

    const childAdapter = getAdapter(review.child_adapter);
    if (childAdapter) {
      try {
        await childAdapter.destroySession(review.child_cli_session_id);
      } catch (err) {
        console.error('[review] Failed to destroy child session:', (err as Error).message);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

- [ ] **Step 2: Update frontend api.ts endReview() to send endAnchorMessageId**

In `src/lib/api.ts`, find the `endReview` function and update it to accept and send `endAnchorMessageId`:

```typescript
endReview: (reviewId: string, endAnchorMessageId?: string) =>
  request(`/api/reviews/${reviewId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endAnchorMessageId }),
  }),
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -E "index.ts|api.ts" | head -5`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add server/index.ts src/lib/api.ts
git commit -m "feat(api): pass endAnchorMessageId when ending review"
```

---

### Task 3: useChat — Convert activeReview to activeReviews Array

**Files:**
- Modify: `src/hooks/useChat.ts:129-136` (state), `src/hooks/useChat.ts:293-307` (WS handlers), return object

- [ ] **Step 1: Define the ReviewInfo type and change state from single to array**

Replace the `activeReview` state (lines 129-136) with:

```typescript
export interface ReviewInfo {
  reviewId: string;
  childSessionId: string;
  childCliSessionId: string;
  childAdapter: string;
  anchorMessageId?: string;
  reviewTitle?: string;
}

const [activeReviews, setActiveReviews] = useState<ReviewInfo[]>([]);
```

- [ ] **Step 2: Update REVIEW_STARTED handler to push to array**

Replace the WS.REVIEW_STARTED case (lines 293-303):

```typescript
case WS.REVIEW_STARTED:
  setActiveReviews(prev => {
    if (prev.some(r => r.reviewId === msg.reviewId)) return prev;
    return [...prev, {
      reviewId: msg.reviewId,
      childSessionId: msg.childSessionId,
      childCliSessionId: msg.childCliSessionId,
      childAdapter: msg.childAdapter,
      anchorMessageId: msg.anchorMessageId,
      reviewTitle: msg.reviewTitle,
    }];
  });
  setActiveReviewPanel('expanded');
  break;
```

- [ ] **Step 3: Update REVIEW_ENDED handler to remove from array**

Replace the WS.REVIEW_ENDED case (lines 305-307):

```typescript
case WS.REVIEW_ENDED:
  setActiveReviews(prev => prev.filter(r => r.reviewId !== msg.reviewId));
  break;
```

- [ ] **Step 4: Update the return object**

In the return statement, replace `activeReview, setActiveReview` with `activeReviews, setActiveReviews`. Keep `activeReviewPanel, setActiveReviewPanel` unchanged.

- [ ] **Step 5: TypeScript check — expect errors in ChatView (will fix in Task 4)**

Run: `npx tsc --noEmit 2>&1 | grep -c "error"`
Expected: Errors in ChatView.tsx and FloatingReviewPanel.tsx (they still reference `activeReview`)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useChat.ts
git commit -m "refactor: activeReview → activeReviews array in useChat"
```

---

### Task 4: ChatView — Wire Up Multi-Review State + Fix Marker Position

**Files:**
- Modify: `src/components/ChatView.tsx` (multiple sections)

- [ ] **Step 1: Update destructuring from useChat**

Replace `activeReview, setActiveReview` with `activeReviews, setActiveReviews` in the useChat destructuring (around line 141).

- [ ] **Step 2: Replace the reviews sync useEffect**

Replace the `prevActiveReviewRef` / `useEffect([activeReview])` block (lines 202-222) with a multi-review version:

```typescript
const prevActiveReviewsRef = useRef(activeReviews);
useEffect(() => {
  const prevIds = new Set(prevActiveReviewsRef.current.map(r => r.reviewId));
  const currIds = new Set(activeReviews.map(r => r.reviewId));

  // New reviews added — merge into reviews state
  for (const review of activeReviews) {
    if (!review.reviewId) continue; // skip placeholders
    if (!prevIds.has(review.reviewId)) {
      setReviews(prev => {
        if (prev.some(r => r.id === review.reviewId)) return prev;
        const cleaned = prev.filter(r => r.id); // remove placeholders
        return [...cleaned, {
          id: review.reviewId,
          child_adapter: review.childAdapter,
          anchor_message_id: review.anchorMessageId,
          review_title: review.reviewTitle,
          ended_at: null,
          end_anchor_message_id: null,
        }];
      });
    }
  }

  // Reviews removed — re-fetch from server to get ended_at + end_anchor_message_id
  for (const prevId of prevIds) {
    if (!currIds.has(prevId)) {
      if (sessionId) {
        api.getReviews(sessionId).then(setReviews).catch(() => {});
      }
      break; // one fetch is enough
    }
  }

  prevActiveReviewsRef.current = activeReviews;
}, [activeReviews, sessionId]);
```

- [ ] **Step 3: Split reviewsByAnchor into start and end maps**

Replace the `reviewsByAnchor` useMemo (lines 229-239):

```typescript
const { startMarkersByAnchor, endMarkersByAnchor } = useMemo(() => {
  const startMap = new Map<string, any[]>();
  const endMap = new Map<string, any[]>();
  for (const r of reviews) {
    if (r.anchor_message_id) {
      const existing = startMap.get(r.anchor_message_id) || [];
      existing.push(r);
      startMap.set(r.anchor_message_id, existing);
    }
    if (r.ended_at) {
      // Use end_anchor_message_id if available, fall back to anchor_message_id
      // (for reviews ended before this feature was added)
      const endKey = r.end_anchor_message_id || r.anchor_message_id;
      if (endKey) {
        const existing = endMap.get(endKey) || [];
        existing.push(r);
        endMap.set(endKey, existing);
      }
    }
  }
  return { startMarkersByAnchor: startMap, endMarkersByAnchor: endMap };
}, [reviews]);
```

- [ ] **Step 4: Update renderReviewMarkers to use split maps**

Replace the `renderReviewMarkers` callback (lines 283-312):

```typescript
const renderReviewMarkers = useCallback((messageId: string, _index: number): React.ReactNode => {
  const startReviews = startMarkersByAnchor.get(messageId);
  const endReviews = endMarkersByAnchor.get(messageId);
  if (!startReviews && !endReviews) return null;

  return (
    <>
      {startReviews?.map((review: any) => (
        <Fragment key={`start-${review.id}`}>
          <BlockMarker
            label={`${getBrand(review.child_adapter).displayName} ${review.review_title || 'Review'} started`}
            color={getBrand(review.child_adapter).color}
          />
          {review.ended_at ? (
            <CollapsedReviewCard
              adapter={review.child_adapter}
              title={review.review_title}
              summary="Tap to view review conversation"
              onClick={() => handleOpenReadOnlyReview(review)}
            />
          ) : (
            <BlockMarker
              label={`${getBrand(review.child_adapter).displayName} Review in progress...`}
              color={getBrand(review.child_adapter).color}
            />
          )}
        </Fragment>
      ))}
      {endReviews?.map((review: any) => (
        <BlockMarker
          key={`end-${review.id}`}
          label="Review ended"
          color={getBrand(review.child_adapter).color}
        />
      ))}
    </>
  );
}, [startMarkersByAnchor, endMarkersByAnchor, handleOpenReadOnlyReview]);
```

- [ ] **Step 5: Update closeReview to pass endAnchorMessageId**

Replace the `closeReview` callback (lines 180-188):

```typescript
const closeReview = useCallback(async (reviewId?: string) => {
  const targetId = reviewId || activeReviews[0]?.reviewId;
  if (!targetId) return;

  // Find last message ID in parent chat for end marker positioning
  const lastMsg = messages[messages.length - 1];
  const endAnchorMessageId = lastMsg?.id || undefined;

  try { await api.endReview(targetId, endAnchorMessageId); } catch {}

  setActiveReviews(prev => prev.filter(r => r.reviewId !== targetId));
  setHistoryReview(null);
  setReviewInitialPrompt(null);
  setReviewCwd(null);
}, [activeReviews, messages]);
```

- [ ] **Step 6: Update openReview to push placeholder to array**

Replace the `openReview` callback (around lines 247-260). Instead of `setActiveReview({...})`, push to the array:

```typescript
const openReview = useCallback((adapter: string, model: string, prompt: string, title: string) => {
  const anchorId = reviewMenuMessageId;
  setReviewMenuMessageId(null);
  if (!anchorId) return;
  patchAdapterPrefs(adapter, { model });
  setHistoryReview(null);
  setActiveReviews(prev => [...prev, {
    reviewId: '', childSessionId: '', childCliSessionId: '',
    childAdapter: adapter, anchorMessageId: anchorId, reviewTitle: title,
  }]);
  setReviewInitialPrompt(prompt);
  setReviewCwd(cwd || null);
  setActiveReviewPanel('expanded');
}, [reviewMenuMessageId, cwd]);
```

- [ ] **Step 7: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep ChatView`
Expected: May have errors related to FloatingReviewPanel props (fixed in Task 5)

- [ ] **Step 8: Commit**

```bash
git add src/components/ChatView.tsx
git commit -m "feat: multi-review state, split start/end markers in ChatView"
```

---

### Task 5: ReviewPanelManager — Tabbed Multi-Review Panel

**Files:**
- Modify: `src/components/FloatingReviewPanel.tsx` → heavy refactor (rename conceptually to ReviewPanelManager)
- Modify: `src/components/ChatView.tsx` (update the FloatingReviewPanel usage)

- [ ] **Step 1: Refactor FloatingReviewPanel to accept an array of reviews**

Update the props interface in `FloatingReviewPanel.tsx`:

```typescript
interface ReviewPanelProps {
  reviews: {
    reviewId: string;
    childSessionId: string;
    childAdapter: string;
    reviewTitle?: string;
  }[];
  onEnd: (reviewId: string) => void;
  onMinimize: () => void;
  initialPrompt?: string; // only for the latest (newly created) review
  cwd?: string;
  onSessionCreated?: (childSessionId: string) => void;
  onSendToReview?: (reviewId: string, text: string) => void;
}
```

- [ ] **Step 2: Implement tabbed panel with per-review useChat**

The component needs one `useChat` hook per review. Since React hooks can't be called conditionally, use a child component pattern — create a `ReviewTab` component that each renders its own `useChat`:

```typescript
function ReviewTab({ review, cwd, initialPrompt, onSessionCreated, isActive, onSendBack }: {
  review: ReviewPanelProps['reviews'][0];
  cwd?: string;
  initialPrompt?: string;
  onSessionCreated?: (sid: string) => void;
  isActive: boolean;
  onSendBack?: (text: string) => void;
}) {
  const {
    messages, streaming, liveStatus, toolStatuses,
    sendMessage, abort, sessionId: chatSessionId,
  } = useChat(
    review.childSessionId || undefined,
    cwd,
    review.childAdapter,
    initialPrompt,
  );

  // Notify parent when child session is created
  useEffect(() => {
    if (chatSessionId && !review.childSessionId && onSessionCreated) {
      onSessionCreated(chatSessionId);
    }
  }, [chatSessionId, review.childSessionId, onSessionCreated]);

  // Expose sendMessage to parent for "send to existing review"
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;

  // IMPORTANT: Do NOT return null — hooks must stay mounted.
  // Hide inactive tabs with CSS instead of unmounting.
  // The outer div controls visibility.

  const brand = getBrand(review.childAdapter);

  return (
    <ChatBody
      messages={messages}
      streaming={streaming}
      liveStatus={liveStatus}
      toolStatuses={toolStatuses || new Map()}
      onSend={sendMessage}
      onStop={abort}
      disabled={false}
      interrupted={false}
      onSendBack={onSendBack ? (msgId: string) => {
        const msg = messages.find(m => m.id === msgId);
        if (msg) onSendBack(extractTextFromBlocks(msg.content));
      } : undefined}
      inputPlaceholder={`Reply to ${brand.displayName} review...`}
      className="flex-1"
    />
  );
}
```

**Important**: Each `ReviewTab` must always render (to keep hooks alive). Wrap each in a div with `style={{ display: isActive ? 'flex' : 'none' }}` so inactive tabs are hidden but hooks stay mounted. Do NOT conditionally return null — that unmounts the hook and loses the child session's WS connection.

- [ ] **Step 3: Implement the outer panel with tab bar and minimize**

The outer `FloatingReviewPanel` component renders:
- Handle bar (click to minimize)
- Tab bar (if multiple reviews) with ▼ minimize button, or single-review header
- Active tab's `ReviewTab` component
- Hidden inactive tabs (hooks stay alive)

Key structure:
```typescript
export function FloatingReviewPanel({ reviews, onEnd, onMinimize, initialPrompt, cwd, onSessionCreated }: ReviewPanelProps) {
  const [activeTabIndex, setActiveTabIndex] = useState(reviews.length - 1);
  // ... tab bar rendering + ReviewTab for each review
}
```

- [ ] **Step 4: Update ChatView to pass reviews array to FloatingReviewPanel**

In ChatView, replace the single `FloatingReviewPanel` render with the new array-based version. Filter out placeholder reviews (reviewId === ''):

```typescript
{activeReviewPanel === 'expanded' && activeReviews.length > 0 && (
  <FloatingReviewPanel
    reviews={activeReviews.filter(r => r.reviewId || r === activeReviews[activeReviews.length - 1])}
    onEnd={(reviewId) => closeReview(reviewId)}
    onMinimize={() => setActiveReviewPanel('minimized')}
    initialPrompt={reviewInitialPrompt || undefined}
    cwd={reviewCwd || undefined}
    onSessionCreated={onSessionCreatedCallback}
  />
)}
```

- [ ] **Step 5: Implement minimized bar for multi-review**

When `activeReviewPanel === 'minimized'`, render the combined minimized bar:

```typescript
{activeReviewPanel === 'minimized' && activeReviews.filter(r => r.reviewId).length > 0 && (
  <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border cursor-pointer hover:bg-white/5"
       onClick={() => setActiveReviewPanel('expanded')}>
    {activeReviews.filter(r => r.reviewId).map(r => (
      <span key={r.reviewId} className="w-1.5 h-1.5 rounded-full" style={{ background: getBrand(r.childAdapter).color }} />
    ))}
    <span className="text-xs text-text-dim flex-1 ml-1">
      {activeReviews.filter(r => r.reviewId).length} review{activeReviews.filter(r => r.reviewId).length > 1 ? 's' : ''}: {activeReviews.filter(r => r.reviewId).map(r => getBrand(r.childAdapter).displayName).join(' · ')}
    </span>
    <span className="text-xs text-text-dim/50">▲ Expand</span>
  </div>
)}
```

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: Clean or minor issues only

- [ ] **Step 7: Commit**

```bash
git add src/components/FloatingReviewPanel.tsx src/components/ChatView.tsx
git commit -m "feat: tabbed multi-review panel with minimize/expand"
```

---

### Task 6: Send-To Existing Review Bottom Sheet

**Files:**
- Create: `src/components/SendToExistingSheet.tsx`
- Modify: `src/components/ChatView.tsx` (handleSendTo logic)

- [ ] **Step 1: Create SendToExistingSheet component**

Create `src/components/SendToExistingSheet.tsx`:

```typescript
import { getBrand } from '../lib/adapters';
import type { ReviewInfo } from '../hooks/useChat';

interface SendToExistingSheetProps {
  visible: boolean;
  activeReviews: ReviewInfo[];
  onSendToExisting: (reviewId: string) => void;
  onStartNew: () => void;
  onClose: () => void;
}

export function SendToExistingSheet({ visible, activeReviews, onSendToExisting, onStartNew, onClose }: SendToExistingSheetProps) {
  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg bg-surface border-t border-border rounded-t-xl p-4 space-y-2 animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-8 h-0.5 rounded-sm bg-border mx-auto mb-3" />
        <p className="text-xs text-text-dim font-mono mb-2">Send to active review</p>

        {activeReviews.map(r => {
          const brand = getBrand(r.childAdapter);
          return (
            <button
              key={r.reviewId}
              onClick={() => onSendToExisting(r.reviewId)}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border hover:bg-white/5 transition-colors text-left"
            >
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded"
                style={{ backgroundColor: `${brand.color}20`, color: brand.color }}
              >
                {brand.displayName}
              </span>
              <span className="text-sm text-text font-mono flex-1 truncate">
                {r.reviewTitle || 'Review'}
              </span>
              <span className="text-xs text-text-dim">→</span>
            </button>
          );
        })}

        <div className="border-t border-border pt-2 mt-2">
          <button
            onClick={onStartNew}
            className="w-full text-left px-3 py-2 text-xs text-text-dim hover:text-text hover:bg-white/5 rounded-lg transition-colors font-mono"
          >
            Start new review...
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update handleSendTo in ChatView**

Replace the `handleSendTo` callback to check for active reviews:

```typescript
const handleSendTo = useCallback((messageId: string, _adapter?: string) => {
  const validReviews = activeReviews.filter(r => r.reviewId);
  if (validReviews.length > 0) {
    // Show the "send to existing" sheet
    setSendToMessageId(messageId);
  } else {
    // No active reviews — go straight to ReviewActionMenu
    setReviewMenuMessageId(messageId);
  }
}, [activeReviews]);
```

Add new state:
```typescript
const [sendToMessageId, setSendToMessageId] = useState<string | null>(null);
```

- [ ] **Step 3: Add handlers for send-to-existing and start-new**

```typescript
const handleSendToExisting = useCallback((reviewId: string) => {
  if (!sendToMessageId) return;
  const msg = messages.find(m => m.id === sendToMessageId);
  if (!msg) return;
  const text = extractTextFromBlocks(msg.content);

  // TODO: send text to the review's child session
  // This requires accessing the ReviewTab's sendMessage — use a ref map
  // exposed by FloatingReviewPanel (see Task 5 onSendToReview prop)
  reviewPanelRef.current?.sendToReview(reviewId, text);

  setSendToMessageId(null);
  setActiveReviewPanel('expanded');
}, [sendToMessageId, messages]);

const handleStartNewFromSheet = useCallback(() => {
  if (sendToMessageId) {
    setReviewMenuMessageId(sendToMessageId);
    setSendToMessageId(null);
  }
}, [sendToMessageId]);
```

- [ ] **Step 4: Render SendToExistingSheet in ChatView**

Add the sheet render near the ReviewActionMenu render:

```typescript
<SendToExistingSheet
  visible={!!sendToMessageId}
  activeReviews={activeReviews.filter(r => r.reviewId)}
  onSendToExisting={handleSendToExisting}
  onStartNew={handleStartNewFromSheet}
  onClose={() => setSendToMessageId(null)}
/>
```

- [ ] **Step 5: Expose sendToReview from FloatingReviewPanel via ref**

In `FloatingReviewPanel.tsx`, use `useImperativeHandle` to expose a `sendToReview(reviewId, text)` method. Each `ReviewTab` registers its `sendMessage` in a ref map. The parent component looks up the right tab and calls `sendMessage(text)`.

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add src/components/SendToExistingSheet.tsx src/components/ChatView.tsx src/components/FloatingReviewPanel.tsx
git commit -m "feat: send-to-existing-review bottom sheet + direct message routing"
```

---

### Task 7: Placeholder Font Size Fix

**Files:**
- Modify: `src/index.css:83-85`
- Modify: `src/components/FloatingReviewPanel.tsx` (textarea class)

- [ ] **Step 1: Add review panel textarea override in CSS**

In `src/index.css`, after the existing `input, textarea, select { font-size: 16px; }` rule (line 85), add:

```css
/* Review panel uses smaller text to fit the compact layout.
   16px stays on main input to prevent iOS Safari auto-zoom. */
.review-panel-compact textarea {
  font-size: 14px;
}
```

- [ ] **Step 2: Add the class to FloatingReviewPanel wrapper**

In `FloatingReviewPanel.tsx`, add `review-panel-compact` class to the panel's outer div:

```typescript
<div className="review-panel-compact absolute bottom-0 left-0 right-0 z-10 flex flex-col rounded-t-xl" ...>
```

- [ ] **Step 3: Verify visually**

Build and check that the review panel placeholder is now 14px while the main chat input remains 16px.

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/components/FloatingReviewPanel.tsx
git commit -m "fix: review panel textarea uses 14px to fit compact layout"
```

---

### Task 8: Integration Test + Cleanup

**Files:**
- Modify: `src/components/ChatView.tsx` (remove any dead code from old single-review pattern)
- Modify: `src/hooks/useChat.ts` (clean up old exports)

- [ ] **Step 1: Remove old single-review exports from useChat**

Ensure `activeReview` (singular) and `setActiveReview` (singular) are completely removed from the return object. Only `activeReviews` and `setActiveReviews` should be exported.

- [ ] **Step 2: Search for any remaining references to old single-review pattern**

Run: `grep -rn "activeReview[^s]" src/ --include="*.tsx" --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`

Fix any remaining references.

- [ ] **Step 3: Build and verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 4: Manual E2E verification checklist**

1. Start a Gemini session from UI → send "Hi" → get response
2. Click "↗ Send to" on the response → should show ReviewActionMenu (no active reviews)
3. Select Codex → Direct Send → child session starts → panel shows with single-review header
4. Click "↗ Send to" on another message → should show SendToExistingSheet with "Send to Codex review" option
5. Click "Start new review..." → ReviewActionMenu opens → select Claude → second tab appears in panel
6. Switch between Codex and Claude tabs
7. Click ▼ to minimize → combined bar shows "2 reviews: Codex · Claude"
8. Click bar to expand → tabs restored
9. Click ✕ on Codex tab → Codex review ends, Claude tab remains
10. Click End on Claude → panel disappears
11. Verify "Review ended" markers appear at the correct positions (not at anchor)
12. Verify CollapsedReviewCards appear at the start anchor positions

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "refactor: clean up old single-review references, verify multi-review integration"
```
