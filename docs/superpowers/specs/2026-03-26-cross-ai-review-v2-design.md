# Cross-AI Review v2 — Multi-Review, Marker Position, Send-To UX

**Date**: 2026-03-26
**Status**: Approved

## Problem

Three issues with the current cross-AI review system:

1. **"Review ended" marker position** — rendered at the anchor message (where "Send to" was clicked), not at the bottom of the chat where the user actually pressed End. Misleading timeline.
2. **"Send to" ignores active reviews** — always opens the full adapter/model selection flow, even when there's already an active review that should receive the message.
3. **Single active review limit** — frontend state (`activeReview`) is a single object. Cannot run multiple reviews simultaneously (e.g., send one message to Codex and another to Claude).

Additionally: **textarea placeholder 16px override** — global CSS `input, textarea, select { font-size: 16px }` (iOS zoom prevention) overrides Tailwind `text-sm` in the review panel, making the placeholder disproportionately large.

## Design

### 1. Review Ended Marker Position

**Current**: "started", "in progress", and "ended" markers are all rendered by `renderReviewMarkers`, keyed by `anchor_message_id`. They all appear after the anchor message.

**New**: Split markers into two locations:
- **"started" + CollapsedReviewCard** — at anchor message (shows where the review was initiated; card lets user tap to view the review conversation)
- **"in progress"** — at anchor message (only for active reviews, replaces CollapsedReviewCard)
- **"ended"** — rendered after the last message in parent chat at the time End was pressed (shows where in the timeline the review concluded)

**Implementation**:
- Add `end_anchor_message_id TEXT` column to `session_reviews` table
- When `endReview()` is called, set `end_anchor_message_id` to the ID of the last message currently in the parent session's message history
- Server: `GET /api/reviews` response already returns all review columns — no API change needed
- Frontend: `renderReviewMarkers` uses two maps:
  - `startMarkersByAnchor` — keyed by `anchor_message_id`:
    - Active review: "started" marker + "in progress" marker
    - Ended review: "started" marker + CollapsedReviewCard (tap to view)
  - `endMarkersByAnchor` — keyed by `end_anchor_message_id`:
    - Ended review only: "Review ended" marker

### 2. Send-To with Active Review

**Current**: Clicking "↗ Send to" always sets `reviewMenuMessageId` → opens `ReviewActionMenu` bottom sheet → full adapter/model flow.

**New**: Two paths based on whether active reviews exist:

**Path A — No active reviews**: Same as current. Full adapter/model selection → create new child session.

**Path B — Active review(s) exist**: Show a simplified bottom sheet with options:
- One button per active review: **"Send to {Adapter} review"** (with adapter badge + color). Clicking sends the message text directly to that child session as a new prompt.
- A divider line
- **"Start new review..."** button at the bottom → opens the current full flow

**Sending to existing review**:
- Extract text from the clicked message
- Call `childChat.sendMessage(text)` on the corresponding review's `useChat` instance
- Auto-expand and switch tab to that review's tab
- No new DB row, no new session — just a follow-up message in the existing child session

### 3. Multi-Review UI (Design D)

**State change**: `activeReview` (single object) → `activeReviews` (array of review objects). Each entry has: `{ reviewId, childSessionId, childCliSessionId, childAdapter, anchorMessageId, reviewTitle }`.

**Minimized state** (all reviews collapsed):
- Single compact bar above the input: colored dots for each review + "{N} reviews: Codex · Claude" + "▲ Expand"
- Clicking the bar expands to the tabbed panel

**Expanded state** (panel visible):
- 50% height bottom panel with:
  - **Handle bar** at top (drag/click to minimize)
  - **Tab bar**: one tab per active review, each showing adapter color dot + name. Active tab underlined with adapter color. Each tab has ✕ to end that review. Right side has ▼ minimize button.
  - **Chat area**: messages for the focused tab's child session
  - **Input**: "Reply to {Adapter} review..." placeholder

**Single review special case**: When only 1 active review, show header (badge + title + ▼ + End) instead of tab bar. Same as current design.

**Each tab is an independent `useChat` hook**. The `FloatingReviewPanel` component manages an array of child chat instances, renders only the active tab's messages, but keeps all hooks alive for background message receipt.

**Tab lifecycle**:
- New review → push to `activeReviews`, add tab, auto-focus it
- End review (✕ or "End" button) → call `api.endReview(reviewId)`, remove from `activeReviews`, focus adjacent tab
- All reviews ended → panel disappears, minimized bar disappears

### 4. Placeholder Font Size Fix

**Root cause**: `src/index.css` line 83: `input, textarea, select { font-size: 16px }` overrides `text-sm` (14px).

**Fix**: Keep the 16px rule for iOS zoom prevention, but add a specific override for the review panel textarea:

```css
.review-panel-input textarea { font-size: 14px !important; }
```

Or use Tailwind's `!text-sm` on the textarea in FloatingReviewPanel. The main chat input stays at 16px (looks fine at full width); only the cramped review panel gets the smaller size.

## Data Flow Changes

### End Review (updated)

```
User taps "End" on tab / End button
  → Frontend: get last message ID from parent chat messages array
  → api.endReview(reviewId, { endAnchorMessageId: lastMsgId })
  → Server: UPDATE session_reviews SET ended_at=NOW(), end_anchor_message_id=?
  → Server: broadcast WS REVIEW_ENDED { reviewId }
  → Server: destroySession(childCliSessionId)
  → Frontend: remove from activeReviews array
  → Frontend: reviews re-fetched → endMarkersByAnchor updated
  → "ended" marker + CollapsedReviewCard appear after the correct message
```

### Send-To Existing Review

```
User taps "↗ Send to" on assistant message (with active reviews present)
  → Simplified bottom sheet: [Send to Codex review] [Send to Claude review] [Start new...]
  → User taps "Send to Codex review"
  → Extract text from the anchor message
  → Find the Codex review's useChat sendMessage function
  → sendMessage(text) → message sent to child session
  → Auto-expand panel, switch to Codex tab
```

## Migration

- New column `end_anchor_message_id` on `session_reviews`: nullable, no migration needed for existing rows (they will show "ended" at anchor position as fallback)

## Scope Exclusions

- Drag-to-reorder tabs: not needed
- Resize panel height: not needed (fixed 50%)
- Review notifications/badges on minimized bar: nice-to-have, not in v2
- Persist expanded/minimized state across page refreshes: not needed
