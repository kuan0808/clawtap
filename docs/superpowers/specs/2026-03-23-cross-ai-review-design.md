# Cross-AI Review

## Overview

A mechanism to send messages from one CLI session (e.g., Claude) to another adapter's CLI session (e.g., Codex) for review, all within the same ChatView. The child session runs in its own tmux window with full codebase access, and its UI is presented as a floating panel over the parent chat.

## Concepts

### Parent Session
The main CLI session the user is working in. Appears in session list and active sessions as normal.

### Child Session (Review Session)
A secondary CLI session triggered from a specific message in the parent. It:
- Runs a different adapter (e.g., parent is Claude, child is Codex)
- Opens in the same `cwd` as the parent (read from parent's DB row, not from client)
- Is a real tmux window, supports full CLI interaction with codebase access
- Does NOT appear in the session list or active sessions
- Is tracked via a separate `session_reviews` DB table
- Its UI appears as a floating panel inside the parent's ChatView
- Uses its own `useChat` hook instance for independent WebSocket connection and message handling

### Relationship
- One parent can have one active (non-ended) child at a time
- If the user tries to start a second review while one is active, show a confirmation: "End current review to start a new one?"
- Each child has an `anchor_message_id` — the ID of the specific assistant message that triggered the review
- Ended reviews remain as collapsed cards in the history; a parent can have many ended reviews

## Naming Conventions

All adapter references in the UI are **dynamic**, never hardcoded:
- "Send to [Codex]" / "Send to [Claude]" — resolved from available adapters via `/api/adapters`
- In child session: "Send to [Parent Adapter Name]" — resolved from parent's adapter
- The "Send to" button is only shown when at least one other adapter is available (`/api/adapters` filtered to `available: true`)
- Review session title is dynamic based on the prompt template selected: "Code Review", "Suggest Alternatives", "Direct Send", or the user's custom instruction (truncated)

## User Flow

### 1. Triggering a Review

Every assistant message in the parent chat has action buttons:
- **Copy** — copy message content
- **Send to [Adapter]** — triggers the cross-AI review flow (adapter name is dynamic)

When the user taps "Send to [Adapter]", a popup menu appears with prompt template options:
- **Direct send** — send the message as-is
- **Code Review** — attach a "please review this code" instruction
- **Suggest alternatives** — ask for different approaches
- **Custom instruction...** — user types their own prompt

After selection:
1. Server creates a new CLI session for the target adapter in tmux (same `cwd` as parent)
2. Context (parent conversation history + selected message + prompt template) is pasted into the child CLI via `tmux load-buffer` + `paste-buffer` (see "Context Passing" section)
3. A floating panel appears at the bottom of the screen
4. Server broadcasts `REVIEW_STARTED` to all parent session clients
5. A `session_reviews` row is created in the DB

### 2. Interacting with the Child Session

The floating panel has three states:

**Expanded** — takes up ~55% of the screen from the bottom. Shows:
- Header with dynamic title: "[Adapter] [Template Name]" (e.g., "Codex Code Review")
- "End" button to close the review
- Chat messages from the child session (with streaming — uses its own `useChat` hook)
- Each child assistant message has:
  - **Copy** button
  - **Send to [Parent Adapter]** button — dynamically named based on parent's adapter
- Input field for the user to ask follow-up questions to the child AI

**Minimized (Pill)** — a small floating pill button in the bottom-right corner. Shows adapter name + template name with a pulsing dot. Tap to expand.

**Hidden** — the floating panel is dismissed but the tmux session continues running in the background.

Users can switch between states by tapping the handle bar (to minimize) or the pill (to expand).

### 3. Sending Results Back to Parent

Each assistant message in the child session has a **"Send to [Parent Adapter]"** button. When tapped:
- **Guard**: if the parent session is currently processing (`isProcessing`), show a toast: "Wait for the current turn to complete"
- Otherwise: the message content is prefixed with "[Review feedback from [Child Adapter]:]" and injected into the parent's tmux session via `sendMessage()`
- The parent AI sees it as a normal user message and can respond
- The user continues working with the parent AI, informed by the review

This is a manual, explicit action. There is no automatic injection.

For long messages, use `tmux load-buffer` + `paste-buffer` (see "Context Passing & Message Delivery" section).

### 4. Ending a Review

The user taps the **"End"** button on the floating panel:
- `ended_at` is set in the `session_reviews` table
- The child's tmux window is killed
- The floating panel disappears
- Server broadcasts `REVIEW_ENDED` to all parent session clients
- The child session's JSONL file is preserved for history

### 5. Viewing History

When the user re-opens the parent session and scrolls through message history:
- At the `anchor_message_id` position, a **block-start marker** is rendered: "[Adapter] [Template] started"
- Immediately after the block-start marker, a **collapsed review card** appears showing:
  - Adapter name, template name, and message count
  - A brief summary (first line of the child AI's first response)
  - "Tap to expand" hint — opens the full child conversation in a read-only panel
- The block-end marker renders immediately after the collapsed review card: "Review ended"
- Parent messages that occurred during the review period continue normally in the chat flow (they are NOT inside the collapsed card — they are separate messages below it)

The block markers are NOT stored in JSONL. They are rendered dynamically by ChatView based on `session_reviews` DB metadata, keyed by `anchor_message_id`.

## Context Passing & Message Delivery

### tmux buffer (unified approach)

All text delivery to CLI sessions uses `tmux load-buffer` + `paste-buffer` instead of `send-keys`. This applies to:
- Initial context sent to child session
- Messages sent back from child to parent ("Send to [Parent Adapter]")
- Any other long-form text injection

**Why not `send-keys`:**
- Special characters (quotes, backslashes, newlines) get interpreted by the shell
- `send-keys -l` processes text character-by-character, slow for large content
- Practical input length limits

**Why not file-based (write file + "read /tmp/xxx.md"):**
- Requires an extra tool call round trip (AI has to read the file)
- Requires file cleanup
- Less direct

**Buffer mechanism:**

```bash
# 1. Write content to a temp file
echo "$content" > /tmp/codetap-buf-{id}.txt

# 2. Load into tmux buffer
tmux load-buffer /tmp/codetap-buf-{id}.txt

# 3. Paste into target pane
tmux paste-buffer -t codetap:{windowId}

# 4. Press Enter to submit
tmux send-keys -t codetap:{windowId} Enter

# 5. Clean up temp file
rm /tmp/codetap-buf-{id}.txt
```

The CLI receives the pasted text as a single multi-line prompt. Both Claude Code and Codex handle pasted multi-line input natively.

### Initial context format

When creating a child session, the context pasted as the first prompt:

```
The following is a conversation between a user and [Parent Adapter].
Please review the highlighted response below.

[Conversation History]
User: [message 1]
[Parent Adapter]: [message 2]
...

>>> REVIEW THIS RESPONSE <<<
[Parent Adapter]: [the selected message content]

[Instruction]
[Prompt template text, e.g., "Please perform a code review..."]
```

Maximum context: last 50 messages or 30KB of text (whichever is smaller). If truncated, prepend "[Earlier conversation omitted]".

### Send-back format

When "Send to [Parent Adapter]" is tapped on a child message, the content pasted to the parent:

```
[Review feedback from [Child Adapter]]:
[message content]
```

## Data Model

### New table: `session_reviews`

```sql
CREATE TABLE IF NOT EXISTS session_reviews (
  id TEXT PRIMARY KEY,
  parent_cli_session_id TEXT NOT NULL,
  child_cli_session_id TEXT NOT NULL,
  child_adapter TEXT NOT NULL,
  anchor_message_id TEXT,
  review_prompt TEXT,
  review_title TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_parent ON session_reviews(parent_cli_session_id);
```

**All session IDs stored are native CLI UUIDs** (e.g., `019d1956-2941-7360-b313-0610d98ee150` for Codex, `4ac007a8-7b04-4646-8f0c-a74845aa01bf` for Claude), NOT internal IDs (e.g., `codex-1774267440443` or `claude-1774269874387`). Internal IDs change on server restart when sessions are recreated; CLI UUIDs are permanent.

This table is **NOT cleared** by `clearAll()` — it survives server restarts. The `sessions` table continues to be cleared as before.

### Filtering child sessions

Child sessions still appear in the `sessions` table (for tmux window tracking). Filtering is done at the **API layer** in `server/index.ts`, not in adapters or JSONL stores. This is because:
- `getSessions()` in both adapters reads from JSONL files, not the DB -- it has no access to `session_reviews`
- `getActiveSessions()` reads from in-memory Maps -- same issue
- The API endpoints already aggregate across adapters, so filtering here is natural

**Implementation:**

For `/api/sessions` and `/api/active-sessions` endpoints in `server/index.ts`:
1. Query `session_reviews` for all `child_cli_session_id` values
2. Build a `Set<string>` of child CLI UUIDs
3. Filter the results: exclude any session whose `cliSessionId` (CLI UUID) is in the set

This keeps adapter code untouched and centralizes the filtering logic.

### Message IDs

The spec uses `anchor_message_id` to identify which message triggered a review. Currently:
- `ChatMessage` type has an optional `id` field, but it is never populated
- JSONL entries from both Claude and Codex do not have dedicated message IDs

**Solution:** Generate synthetic UUIDs for each message at parse time in `TranscriptParser` (Claude) and `CodexTranscriptParser` (Codex). These IDs are:
- Generated deterministically or at parse time
- Threaded through to `ChatMessage.id` in the React state
- Passed to `MessageBubble` as a prop for action button callbacks
- Stored as `anchor_message_id` in `session_reviews` when a review is triggered

### DB operations

Add a `sessionReviews` operation set to `server/db.ts`:

- `create(id, parentCliId, childCliId, childAdapter, anchorMsgId, prompt, title)` -- insert new review
- `getActiveForParent(parentCliSessionId)` -- active reviews for reconnect
- `getAllChildIds()` -- all child CLI UUIDs for session list filtering
- `endReview(reviewId)` -- sets ended_at
- `getForParent(parentCliSessionId)` -- all reviews including ended (for history rendering)

### TmuxManager changes

Add a `pasteBuffer(windowId, content)` method to `server/adapters/claude/tmux-manager.ts`:
1. Write content to a temp file
2. `tmux load-buffer <tmpFile>`
3. `tmux paste-buffer -t codetap:<windowId>`
4. `tmux send-keys -t codetap:<windowId> Enter`
5. Clean up temp file

Uses `execFile` (not `exec`) for safety, consistent with existing TmuxManager methods.

This replaces `sendKeys()` for all cross-AI review text delivery (initial context + send-back). Regular `sendMessage()` in adapters continues to use `sendKeys()` for short user prompts.

## WebSocket Events

Two new event types for review lifecycle:

```typescript
// server → client: a review session was created
REVIEW_STARTED = 'review-started'
{
  type: 'review-started',
  reviewId: string,
  childSessionId: string,    // internal session ID for useChat connection
  childCliSessionId: string, // CLI UUID
  childAdapter: string,
  anchorMessageId: string,
  reviewTitle: string,
}

// server → client: a review session was ended
REVIEW_ENDED = 'review-ended'
{
  type: 'review-ended',
  reviewId: string,
}
```

These are broadcast to all clients connected to the parent session. On receiving `REVIEW_STARTED`, the client creates a `FloatingReviewPanel` with its own `useChat` hook instance pointing to the child session.

## Reconnect / Server Restart

### Reconnecting to a parent session with active child

When a user opens a parent session:
1. Query DB: `SELECT * FROM session_reviews WHERE parent_cli_session_id = ? AND ended_at IS NULL`
2. For each active child (at most one, enforced by the one-active-child rule):
   - Resolve the child CLI UUID to an internal session ID
   - Check if the tmux window still exists
   - If yes: re-attach (start monitoring events), show floating panel
   - If no (e.g., server restarted): use `resumeSession` with the child CLI UUID to create a new tmux window, show floating panel
3. For ended children: do nothing at connect time. ChatView renders collapsed review cards when scrolling through history by querying `session_reviews` for this parent.

### clearAll() behavior

`clearAll()` clears the `sessions` table on shutdown. The `session_reviews` table is NOT cleared. On next startup:
- `session_reviews` still has the parent-child relationships (keyed by CLI UUIDs)
- Child session JSONL files still exist on disk
- History view works correctly

## UI Components

### New Components
- **FloatingReviewPanel** — the expandable/minimizable floating panel for child session interaction. Uses its own `useChat` hook instance with the child's session ID.
- **FloatingReviewPill** — the minimized pill button
- **ReviewActionMenu** — the popup menu when "Send to [Adapter]" is tapped (prompt template selection)
- **CollapsedReviewCard** — the folded review card shown in history view
- **BlockMarker** — the "Review started" / "Review ended" divider lines

### Modified Components
- **MessageBubble** — add "Copy" and "Send to [Adapter]" action buttons to each assistant message. Adapter name is dynamic.
- **ChatView** — integrate FloatingReviewPanel, render block markers and collapsed cards in history, manage child session lifecycle
- **useChat hook** — add review state management (active review ID, floating panel visibility). Does NOT handle child session messages — that is delegated to the child's own `useChat` instance inside `FloatingReviewPanel`.

### Removed Components
- **QuickActionCards** — replaced by per-message action buttons
- **CrossAdapterFlow** — replaced by the new review mechanism
- **quick-commands.ts** — prompt templates moved into ReviewActionMenu
- `crossAdapterFlow` state, `startCrossAdapterFlow`, `completeCrossAdapterFlow` in useChat — all removed

## Scope Boundaries (NOT included in v1)

- **Auto N-round debate** — two AIs automatically going back and forth. Deferred due to JSONL duplication complexity.
- **Multi-child sessions** — only one active child at a time. Multiple ended reviews are fine.
- **More than 2 adapters** — the architecture supports it (dynamic naming, adapter list from API), but UI is only tested with Claude + Codex.

## Interactive Mockup

A visual mockup is available at `/tmp/cross-ai-review-mockup.html` showing three views:
1. **Live view** — review in progress with floating panel (expanded + minimized pill states)
2. **History view** — review ended with collapsed card + block markers + interleaved parent messages
3. **Menu view** — the prompt template selection popup
