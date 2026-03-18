# Cross-AI Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable sending messages between CLI sessions (e.g., Claude to Codex) for cross-AI review, with a floating panel UI inside ChatView.

**Architecture:** Three phases: (1) backend infrastructure (DB, tmux, WS events, message IDs), (2) review session lifecycle (create, send-back, end, reconnect), (3) frontend UI (floating panel, action buttons, history view, remove old components).

**Tech Stack:** TypeScript, SQLite (better-sqlite3), tmux, React, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-23-cross-ai-review-design.md`

---

## Phase 1: Backend Infrastructure

### Task 1: Add `session_reviews` DB table

**Files:**
- Modify: `server/db.ts`

- [ ] **Step 1: Add CREATE TABLE in initDB()**

In `server/db.ts`, inside `initDB()` after the existing `CREATE TABLE` statements (~line 58), add:

```sql
CREATE TABLE IF NOT EXISTS session_reviews (
  id TEXT PRIMARY KEY,
  parent_cli_session_id TEXT NOT NULL,
  child_cli_session_id TEXT NOT NULL,
  child_adapter TEXT NOT NULL,
  anchor_message_id TEXT,
  review_prompt TEXT,
  review_title TEXT,
  message_count INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_parent ON session_reviews(parent_cli_session_id);
```

- [ ] **Step 2: Add SessionReviewRow interface**

After the `SessionRow` interface (~line 249):

```typescript
export interface SessionReviewRow {
  id: string;
  parent_cli_session_id: string;
  child_cli_session_id: string;
  child_adapter: string;
  anchor_message_id: string | null;
  review_prompt: string | null;
  review_title: string | null;
  message_count: number;
  started_at: string;
  ended_at: string | null;
}
```

- [ ] **Step 3: Add prepared statements to PreparedStatements interface and stmts()**

Add five statements: `reviewCreate`, `reviewGetById`, `reviewGetActiveForParent`, `reviewGetAllForParent`, `reviewGetAllChildIds`, `reviewEnd`.

- [ ] **Step 4: Add sessionReviews operations export**

```typescript
export const sessionReviews = {
  create(id, parentCliId, childCliId, childAdapter, anchorMsgId?, prompt?, title?): void,
  getById(reviewId): SessionReviewRow | undefined,
  getActiveForParent(parentCliSessionId): SessionReviewRow[],
  getAllForParent(parentCliSessionId): SessionReviewRow[],
  getAllChildIds(): Set<string>,
  endReview(reviewId, messageCount?): void,
  updateChildCliId(internalId, cliId): void,
};
```

- [ ] **Step 5: Verify DB loads without errors**

Run: `CLAUDE_UI_PASSWORD=test npx tsx server/index.ts`
Expected: `[db] SQLite database initialized` with no errors.

- [ ] **Step 6: Commit**

```bash
git add server/db.ts
git commit -m "feat: add session_reviews DB table for cross-AI review tracking"
```

---

### Task 2: Add `pasteBuffer()` to TmuxManager + `pasteToSession()` to IAdapter

**Files:**
- Modify: `server/adapters/claude/tmux-manager.ts`
- Modify: `server/adapters/interface.ts`
- Modify: `server/adapters/claude/index.ts`
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/codex/index.ts`
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`

- [ ] **Step 1: Add pasteBuffer method to TmuxManager**

Add imports for `writeFileSync`, `unlinkSync` from `fs` and `randomUUID` from `crypto`. Then add after `sendControl()` (~line 48):

```typescript
async pasteBuffer(windowId: string, content: string): Promise<void> {
  const tmpFile = `/tmp/codetap-buf-${randomUUID()}.txt`;
  writeFileSync(tmpFile, content);
  const target = `${SESSION_NAME}:${windowId}`;
  try {
    await exec(TMUX, ['load-buffer', tmpFile]);
    await exec(TMUX, ['paste-buffer', '-t', target]);
    await exec(TMUX, ['send-keys', '-t', target, 'Enter']);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
```

Note: `exec` here is the existing `promisify(execFile)` wrapper already in the file. Not `child_process.exec`.

- [ ] **Step 2: Add `pasteToSession()` to IAdapter interface**

In `server/adapters/interface.ts`, add to the IAdapter class:

```typescript
async pasteToSession(sessionId: string, content: string): Promise<void> {
  throw new Error('Not implemented');
}
```

- [ ] **Step 3: Implement in both adapters**

In Claude's `tmux-adapter.ts`:

```typescript
async pasteToSession(sessionId: string, content: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  await tmuxManager.pasteBuffer(session.windowId, content);
}
```

In Claude's `index.ts`, delegate: `async pasteToSession(sid: string, content: string) { return this._tmux.pasteToSession(sid, content); }`

In Codex's `codex-tmux-adapter.ts`, same pattern. In Codex's `index.ts`, delegate.

This keeps `tmuxManager` as an internal detail. `server/index.ts` only calls `adapter.pasteToSession()`.

- [ ] **Step 4: Commit**

```bash
git add server/adapters/claude/tmux-manager.ts server/adapters/interface.ts server/adapters/claude/index.ts server/adapters/claude/tmux-adapter.ts server/adapters/codex/index.ts server/adapters/codex/codex-tmux-adapter.ts
git commit -m "feat: add pasteBuffer to TmuxManager and pasteToSession to IAdapter"
```

---

### Task 3: Add WS event types

**Files:**
- Modify: `server/ws-types.ts`
- Modify: `src/lib/ws-types.ts`
- Modify: `server/types/messages.ts`

- [ ] **Step 1: Add REVIEW_STARTED and REVIEW_ENDED to both ws-types files**

In both `server/ws-types.ts` and `src/lib/ws-types.ts`, add to the `WS` object:

```typescript
REVIEW_STARTED: 'review-started',
REVIEW_ENDED: 'review-ended',
```

- [ ] **Step 2: Update ServerMessageType**

In `server/types/messages.ts`, add `| 'review-started' | 'review-ended'` to `ServerMessageType`.

- [ ] **Step 3: Commit**

```bash
git add server/ws-types.ts src/lib/ws-types.ts server/types/messages.ts
git commit -m "feat: add REVIEW_STARTED and REVIEW_ENDED WS event types"
```

---

### Task 4: Add deterministic message IDs to parsers

**Files:**
- Modify: `server/adapters/claude/transcript-parser.ts`
- Modify: `server/adapters/codex/transcript-parser.ts`
- Modify: `src/hooks/useChat.ts`

**Critical design note:** IDs must be **deterministic** — the same JSONL entry must produce the same ID every time it's parsed (across reconnects, server restarts, page refreshes). Using `randomUUID()` would break `anchor_message_id` lookups in history.

**Approach:** Use a monotonic counter per parser instance. Each parser tracks an `_entryIndex` that increments for every message. The ID is `msg-{entryIndex}` (e.g., `msg-0`, `msg-1`, `msg-5`). Since JSONL is append-only, the same entries always produce the same indices.

- [ ] **Step 1: Add `id` field to Claude's ParsedMessage interface**

In `server/adapters/claude/transcript-parser.ts` (~line 15), add `id: string` to `ParsedMessage`.

- [ ] **Step 2: Generate deterministic IDs in Claude parser**

Add a counter `private _msgIndex = 0` to the `TranscriptParser` class. In `_parseUserEntry()` and `_parseAssistantEntry()`, set `id: \`msg-${this._msgIndex++}\`` on each returned message. Reset counter in constructor or when `parse()` is called fresh for history.

- [ ] **Step 3: Generate deterministic IDs in Codex parser**

Same pattern in `server/adapters/codex/transcript-parser.ts`. Add counter, generate `msg-{index}` IDs. The `ChatMessage` type already has `id?: string`.

- [ ] **Step 4: Thread IDs through useChat**

In `src/hooks/useChat.ts`:
- Add `id?: string` to the local `ChatMessage` type (~line 14)
- In `convertMessages()` (~line 68), preserve `id` from incoming messages: `{ id: msg.id, role: ..., content: ... }`
- In the `MESSAGE_COMPLETE` handler, preserve `id` when converting messages
- In the `HISTORY_LOAD` handler, preserve `id` when converting messages

- [ ] **Step 5: Commit**

```bash
git add server/adapters/claude/transcript-parser.ts server/adapters/codex/transcript-parser.ts src/hooks/useChat.ts
git commit -m "feat: add deterministic message IDs to parsers for stable anchor references"
```

---

### Task 5: Filter child sessions from API endpoints

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Import sessionReviews**

Add `import { sessionReviews } from './db.js';` at top.

- [ ] **Step 2: Filter /api/sessions**

After aggregating sessions from all adapters, filter out children:

```typescript
const childIds = sessionReviews.getAllChildIds();
const filtered = allSessions.filter((s: any) => !childIds.has(s.sessionId));
res.json(filtered);
```

- [ ] **Step 3: Filter /api/active-sessions**

After building `allActiveSessions`, filter:

```typescript
const childIds = sessionReviews.getAllChildIds();
const filtered = allActiveSessions.filter((s: any) => !childIds.has(s.cliSessionId));
res.json(filtered);
```

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: filter child review sessions from session list and active sessions"
```

---

## Phase 2: Review Session Lifecycle

### Task 6: Add review API endpoints

**Files:**
- Modify: `server/index.ts`

All endpoints use `authMiddleware`, following the existing pattern.

- [ ] **Step 1: Add POST /api/reviews**

Creates a child CLI session, saves review to DB, pastes context, returns review metadata.

Key logic:
- Check for existing active review (`sessionReviews.getActiveForParent`) — return 409 if active
- Look up parent's `cwd` from DB (`dbSessions.findByCliSession`)
- Call `adapter.startSession(cwd, { permissionMode: 'bypassPermissions' })`
- **Codex UUID timing issue:** For Claude, `cliSessionId` is available immediately after `startSession()`. For Codex, it's empty until `SessionStart` hook fires. **Workaround:** Create the `session_reviews` row with the internal session ID as a temporary `child_cli_session_id`. Add a step in Codex's `handleSessionStart` hook to update the review row once the real UUID is known. Add `sessionReviews.updateChildCliId(reviewId, newCliId)` method.
- Paste context via `adapter.pasteToSession(childSessionId, context)` (NOT tmuxManager directly)
- Context truncation: cap at last 50 messages or 30KB, whichever is smaller
- Return `{ reviewId, childSessionId, childCliSessionId, childAdapter }`

- [ ] **Step 2: Add DELETE /api/reviews/:id**

Ends review: sets `ended_at`, destroys child tmux window, broadcasts `REVIEW_ENDED`.

Key logic:
- `sessionReviews.getById(reviewId)` to find the review
- `sessionReviews.endReview(reviewId)`
- Find child adapter via `getAdapter(review.child_adapter)`
- Resolve child CLI UUID to internal ID, call `adapter.destroySession(childSessionId)`
- Broadcast `REVIEW_ENDED` to parent session clients

- [ ] **Step 3: Add POST /api/reviews/:id/send-back**

Sends a child message back to parent.

Key logic:
- Look up review, find parent session via `dbSessions.findByCliSession(review.parent_cli_session_id)`
- Resolve parent internal ID from DB row
- **Guard:** check `adapter.isProcessing(parentInternalId)` — return 409 if busy with toast message
- Format message: `[Review feedback from {childAdapter}]:\n{message}`
- Call `parentAdapter.pasteToSession(parentInternalId, formatted)` (NOT tmuxManager directly)

- [ ] **Step 4: Add GET /api/reviews**

Returns reviews for a parent session (for history rendering):

```
GET /api/reviews?parentCliSessionId=xxx
```

Returns `SessionReviewRow[]` from `sessionReviews.getAllForParent(parentCliSessionId)`.

- [ ] **Step 5: Add sessionReviews.updateChildCliId() to db.ts**

For the Codex UUID timing issue:

```typescript
updateChildCliId(internalId: string, cliId: string): void {
  stmts().reviewUpdateChildCliId.run(cliId, internalId);
}
```

With prepared statement: `UPDATE session_reviews SET child_cli_session_id = ? WHERE child_cli_session_id = ?`

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/db.ts
git commit -m "feat: add review API endpoints (create, end, send-back, list)"
```

---

### Task 7: Broadcast review events, reconnect, cascade cleanup, push suppression

**Files:**
- Modify: `server/session-manager.ts`

- [ ] **Step 1: Import sessionReviews and add broadcast helpers**

```typescript
import { sessionReviews } from './db.js';
```

Add `broadcastReviewStarted()` and `broadcastReviewEnded()` helper functions that call the existing `broadcast()` function with `WS.REVIEW_STARTED` / `WS.REVIEW_ENDED` payloads.

Export them so `server/index.ts` can call them from review API endpoints.

- [ ] **Step 2: Add child session restore to handleReconnect**

After existing reconnect logic, query `sessionReviews.getActiveForParent(cliSessionId)`. For each active child:
- Resolve child CLI UUID to internal ID
- If session not managed: call `resumeSession` to recreate tmux window
- Send `REVIEW_STARTED` event to the reconnecting client

- [ ] **Step 3: Add cascade cleanup on parent session destruction**

In `setupSessionManager()`, inside the `session-ended` event handler for each adapter, add:

```typescript
adapter.on('session-ended', (sessionId: string) => {
  // existing: broadcast SESSION_ENDED, clean up maps

  // NEW: cascade-end any active child reviews
  const session = adapter.getSession(sessionId) as { cliSessionId?: string } | null;
  const parentCliId = session?.cliSessionId;
  if (parentCliId) {
    const activeChildren = sessionReviews.getActiveForParent(parentCliId);
    for (const child of activeChildren) {
      sessionReviews.endReview(child.id);
      const childAdapter = getAdapter(child.child_adapter);
      if (childAdapter) {
        const childInternalId = /* resolve from child_cli_session_id */;
        childAdapter.destroySession(childInternalId).catch(() => {});
      }
      broadcast(sessionId, { type: WS.REVIEW_ENDED, reviewId: child.id });
    }
  }
});
```

- [ ] **Step 4: Suppress push notifications for child sessions**

In the `triggerPush()` function at the top of `session-manager.ts`, add a guard:

```typescript
function triggerPush(adapter: IAdapter, sessionId: string, opts: PushOptions): void {
  // existing: skip if clients connected

  // NEW: skip push for child review sessions
  const session = adapter.getSession(sessionId) as { cliSessionId?: string } | null;
  if (session?.cliSessionId && sessionReviews.getAllChildIds().has(session.cliSessionId)) return;

  // existing push logic...
}
```

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts
git commit -m "feat: review events, reconnect restore, cascade cleanup, push suppression"
```

---

## Phase 3: Frontend UI

### Task 8: Add review API methods and state to frontend

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/useChat.ts`

- [ ] **Step 1: Add review API methods to api.ts**

Add `createReview`, `endReview`, `sendBackToParent`, `getReviews` methods.

- [ ] **Step 2: Add review state to useChat**

Add `activeReview` state (object with reviewId, childSessionId, childAdapter, etc.) and `reviewPanelState` ('expanded'|'minimized'|'hidden').

- [ ] **Step 3: Handle REVIEW_STARTED and REVIEW_ENDED in WS handler**

In the `handleWsMessage` switch, add cases for `WS.REVIEW_STARTED` (set activeReview + expand panel) and `WS.REVIEW_ENDED` (clear activeReview + hide panel).

- [ ] **Step 4: Remove old crossAdapterFlow state, methods, and imports**

Remove from useChat.ts:
- `import { getQuickCommand } from '../lib/quick-commands'` (line 5) — this file will be deleted in Task 13
- `CrossAdapterFlowState` type and export
- `crossAdapterFlow` state and `crossAdapterFlowRef`
- `startCrossAdapterFlow` and `completeCrossAdapterFlow` callbacks
- The `crossAdapterFlow` check in `TURN_COMPLETE` handler
- All related entries in the return statement

**Note:** Task 13 Step 6 deletes `quick-commands.ts`. If this import isn't removed first, the build breaks.

- [ ] **Step 5: Export new review state and actions**

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/hooks/useChat.ts
git commit -m "feat: add review API methods and state to useChat, remove crossAdapterFlow"
```

---

### Task 9: Add action buttons to MessageBubble

**Files:**
- Modify: `src/components/MessageBubble.tsx`

- [ ] **Step 1: Add props for messageId, showActions, otherAdapterName, onSendTo**

- [ ] **Step 2: Render Copy and "Send to [Adapter]" buttons after assistant message content**

Only show when `showActions && !isStreaming && otherAdapterName` is truthy.

- [ ] **Step 3: Commit**

```bash
git add src/components/MessageBubble.tsx
git commit -m "feat: add Copy and Send-to action buttons to MessageBubble"
```

---

### Task 10: Create ReviewActionMenu component

**Files:**
- Create: `src/components/ReviewActionMenu.tsx`

- [ ] **Step 1: Create component**

Modal overlay with 4 options: Direct send, Code Review, Suggest alternatives, Custom instruction.
Custom shows an inline text input.
Props: `visible`, `adapterName`, `onSelect(templateId, customPrompt?)`, `onClose`.

- [ ] **Step 2: Commit**

```bash
git add src/components/ReviewActionMenu.tsx
git commit -m "feat: create ReviewActionMenu for prompt template selection"
```

---

### Task 11: Create FloatingReviewPanel component

**Files:**
- Create: `src/components/FloatingReviewPanel.tsx`

- [ ] **Step 1: Create component**

Key details:
- Uses its own `useChat(childSessionId, undefined, childAdapter)` hook instance
- Three states: expanded (55% height), minimized (pill button), hidden
- Shows child session messages with MessageBubble (including "Send to [Parent]" buttons)
- Has ShimmerInput for user input to child session
- Header shows adapter brand color, review title, End button
- End button calls `onEnd` callback

- [ ] **Step 2: Commit**

```bash
git add src/components/FloatingReviewPanel.tsx
git commit -m "feat: create FloatingReviewPanel with independent useChat"
```

---

### Task 12: Create CollapsedReviewCard and BlockMarker

**Files:**
- Create: `src/components/CollapsedReviewCard.tsx`
- Create: `src/components/BlockMarker.tsx`

- [ ] **Step 1: Create BlockMarker**

Simple divider line with a centered label pill. Props: `label`, `color`.

- [ ] **Step 2: Create CollapsedReviewCard**

Card showing adapter name, title, message count, summary. Props: `adapter`, `title`, `messageCount`, `summary`, `onClick`. Uses adapter brand colors.

- [ ] **Step 3: Commit**

```bash
git add src/components/CollapsedReviewCard.tsx src/components/BlockMarker.tsx
git commit -m "feat: create CollapsedReviewCard and BlockMarker components"
```

---

### Task 13: Integrate into ChatView + remove old components

**Files:**
- Modify: `src/components/ChatView.tsx`
- Delete: `src/components/QuickActionCards.tsx`
- Delete: `src/components/CrossAdapterFlow.tsx`
- Delete: `src/lib/quick-commands.ts`

- [ ] **Step 1: Remove old imports and JSX**

Remove `QuickActionCards`, `CrossAdapterFlow` imports and their JSX. Remove `crossAdapterFlow` related destructuring from useChat.

- [ ] **Step 2: Add new imports**

Import `FloatingReviewPanel`, `ReviewActionMenu`, `CollapsedReviewCard`, `BlockMarker`.

- [ ] **Step 3: Fetch review history on mount**

On mount (and on `cliSessionId` change), fetch reviews for this session:

```typescript
const [reviews, setReviews] = useState<SessionReviewRow[]>([]);

useEffect(() => {
  if (!cliSessionId) return;
  api.getReviews(cliSessionId).then(setReviews).catch(() => {});
}, [cliSessionId]);
```

Build a lookup map for rendering:

```typescript
const reviewsByAnchor = useMemo(() => {
  const map = new Map<string, SessionReviewRow>();
  for (const r of reviews) {
    if (r.anchor_message_id) map.set(r.anchor_message_id, r);
  }
  return map;
}, [reviews]);
```

- [ ] **Step 4: Add review trigger logic**

Add `reviewMenuMessageId` state, `handleSendTo` callback (opens menu for a message), `handleReviewSelect` callback (calls `api.createReview` with context built from messages).

Context building: slice messages up to anchor, format as text with 50-message / 30KB cap. Append highlighted message and prompt template.

- [ ] **Step 5: Render messages with block markers and review cards**

In the `messages.map()` loop, after rendering each message, check if it's an anchor:

```tsx
{messages.map((msg, i) => (
  <React.Fragment key={msg.id || i}>
    <MessageBubble ... />
    {msg.id && reviewsByAnchor.has(msg.id) && (() => {
      const review = reviewsByAnchor.get(msg.id)!;
      return (
        <>
          <BlockMarker label={`${getBrand(review.child_adapter).displayName} ${review.review_title || 'Review'} started`} color={getBrand(review.child_adapter).color} />
          <CollapsedReviewCard
            adapter={review.child_adapter}
            title={review.review_title}
            messageCount={0}  // TODO: fetch from child JSONL
            summary="Tap to view review conversation"
            onClick={() => { /* open read-only panel */ }}
          />
          {review.ended_at && (
            <BlockMarker label="Review ended" color={getBrand(review.child_adapter).color} />
          )}
        </>
      );
    })()}
  </React.Fragment>
))}
```

- [ ] **Step 6: Add new components to JSX (FloatingReviewPanel + ReviewActionMenu)**

Replace old `QuickActionCards` / `CrossAdapterFlow` with `FloatingReviewPanel` (conditional on `activeReview`) and `ReviewActionMenu` (conditional on `reviewMenuMessageId`).

- [ ] **Step 7: Pass action props to MessageBubble**

Add `messageId`, `showActions`, `otherAdapterName`, `onSendTo` props. Only show actions when `availableAdapters.length > 1`.

- [ ] **Step 8: Delete old files**

```bash
rm src/components/QuickActionCards.tsx src/components/CrossAdapterFlow.tsx src/lib/quick-commands.ts
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: integrate Cross-AI Review into ChatView, remove old QuickActionCards"
```

---

## Edge Cases Handled in Plan

The following edge cases were identified and addressed across the tasks above:

### Session State Edge Cases
- **Active review should NOT show CollapsedReviewCard** (Task 13 Step 5): When rendering, check `review.ended_at` — only show collapsed card for ended reviews. Active reviews are shown via the floating panel, not inline.
- **Multiple reviews on same anchor message** (Task 13 Step 3): Use `Map<string, SessionReviewRow[]>` (array), not `Map<string, SessionReviewRow>`, to support multiple reviews anchored to the same message.
- **CollapsedReviewCard message count** (Task 1): Add `message_count INTEGER DEFAULT 0` column to `session_reviews`. Set it when the review ends (`endReview` method also stores the count). Avoids needing to read child JSONL at render time.

### User Action Edge Cases
- **409 when review already active** (Task 13 Step 4): `handleReviewSelect` should catch 409 from `api.createReview()`, show a confirmation dialog "End current review and start new one?", and if confirmed, call `endReview` then retry.
- **"Send to Parent" while parent is busy** (Task 11): Pass `parentStreaming` state as a prop to `FloatingReviewPanel`. Disable the "Send to Parent" button when `parentStreaming` is true. The parent's `useChat` `streaming` state is available in ChatView and can be passed down.
- **Input focus confusion** (Task 11): Use distinct placeholder text ("Message Claude..." vs "Message Codex reviewer...") and border colors on the two input fields to prevent accidentally typing in the wrong one.

### Connection/Lifecycle Edge Cases
- **Stale review (server restarted, review never ended)** (Task 7 Step 2): During reconnect, if the child CLI UUID cannot be resolved AND no tmux window exists, mark the review as ended (`sessionReviews.endReview(review.id)`) instead of trying to resume. Show it as a collapsed card.
- **Parent tmux crashes → cascade cleanup timing** (Task 7 Step 3): The `session-ended` event fires AFTER `sessions.delete()`, so `adapter.getSession()` returns null. Save `cliSessionId` BEFORE the session is deleted by looking it up in DB (`dbSessions.findByCliSession`) as a fallback.
- **Codex UUID window** (Task 6 Step 5): Between `startSession()` and `handleSessionStart` hook, the child CLI UUID is unknown. During this brief window (~1-3 seconds), the child session may appear in session list. Accept this as a known limitation for v1 — the cleanup interval will correct it.
- **Child tmux crashes during review** (Task 7 Step 3): Add the same `session-ended` cascade handler for child sessions — when a child session ends unexpectedly, mark the review as ended and broadcast `REVIEW_ENDED`.

### History Edge Cases
- **Keep reviews state in sync via WS** (Task 8 Step 3): On `REVIEW_STARTED`, append to local `reviews` state array. On `REVIEW_ENDED`, update the matching review's `ended_at`. Avoid re-fetching from API on every event.
- **Anchor message compacted away** (Task 13 Step 5): If the anchor message ID is not found in the rendered messages, render the review card at the END of the message list as a fallback (with a note "Original message no longer available").

### Multi-Client Edge Cases
- **Two tabs open** (Task 7 Step 1): `broadcastReviewStarted` and `broadcastReviewEnded` are broadcast to ALL clients on the parent session. Both tabs receive the events and update independently. Tab A gets the API response directly; Tab B gets the WS event. Both converge.

---

## Verification

After all tasks:

1. `CLAUDE_UI_PASSWORD=test npm run dev`
2. Open `http://localhost:5173`
3. **Open a Claude session** -- assistant messages show "Copy" and "Send to Codex" buttons
4. **Tap "Send to Codex"** -- ReviewActionMenu appears with template options
5. **Select "Code Review"** -- floating panel opens, Codex session starts, context pasted
6. **Chat with Codex** in floating panel -- messages appear with streaming
7. **Tap "Send to Claude"** on a Codex response -- content injected into Claude's tmux
8. **Minimize panel** -- pill button appears, tap to re-expand
9. **End review** -- panel disappears, tmux window killed
10. **Session list** -- child session NOT visible in project sessions or active sessions
11. **Reconnect** -- refresh page, active review panel restores
12. **Scroll history** -- block markers and collapsed review card visible at anchor position
