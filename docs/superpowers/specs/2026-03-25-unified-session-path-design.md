# Unified Session Creation Path for Cross-AI Review

## Context

Cross-AI Review child sessions currently use a different creation path than normal sessions:

- **Normal session**: WebUI sends WS `QUERY` → `handleQuery` → `startSession` + `registerClient` + `sendMessage` — all in one handler, atomically.
- **Review child**: HTTP `POST /api/reviews` → `startSession` + `pasteToSession` on server → broadcast `REVIEW_STARTED` → FloatingReviewPanel mounts → `useChat` sends WS `RECONNECT` → `registerClient` — split across HTTP and WS.

This split causes race conditions (rekey happens before WS client connects) and requires defensive mechanisms (`rekeyAliases`, `session-rekeyed` event forwarding) that wouldn't be needed if both paths were the same.

**Insight**: A review child session IS a normal new session. The only difference is the first message is review context instead of user-typed text. It should go through the same QUERY flow.

## Design

### 1. Codex `sendMessage` — auto-handle large/multiline content

Currently Codex adapter has two methods:
- `sendMessage` — uses `sendKeys` (character-by-character, doesn't handle newlines)
- `pasteToSession` — uses `pasteBuffer` (bulk paste, replaces `\n` with `\\n`)

Review context is large (30KB+) and multiline. If it goes through `sendMessage` via QUERY, `sendKeys` would be extremely slow and newlines would be treated as separate message submissions.

**Fix**: Make `sendMessage` auto-detect and use `pasteBuffer` for large/multiline content. Transparent to all callers.

**Important**: Fresh Codex sessions have TUI placeholder text (e.g., "Use /skills to list available skills"). Pasting via `pasteBuffer` appends to the placeholder, truncating the first ~20 chars. The existing fix (from this session) splits the paste: send the `[CODETAP_REF:...]` marker via `sendKeys` first (triggers TUI to clear placeholder), wait 200ms, then `pasteBuffer` the rest. The unified `sendMessage` must preserve this behavior.

```
sendMessage(sessionId, text):
  if text.length > 500 || text.includes('\n'):
    singleLine = text.replace(/\n/g, '\\n')
    // Check for CODETAP_REF marker at start (fresh session with placeholder)
    markerMatch = singleLine.match(/^\[CODETAP_REF:[^\]]+\]/)
    if markerMatch:
      sendKeys(marker)           // clears TUI placeholder
      wait 200ms
      pasteBuffer(rest)          // fast, placeholder already cleared
    else:
      pasteBuffer(singleLine)    // existing session, no placeholder issue
    wait 300ms
    sendControl('Enter')
  else:
    sendKeys(text)               // character-by-character, fine for short text
    wait 200ms
    sendControl('Enter')
```

This merges `sendMessage` and `pasteToSession` into one method that handles all cases.

**Files**: `server/adapters/codex/codex-tmux-adapter.ts`

### 2. Frontend — review child uses QUERY, not RECONNECT

**Current flow**:
```
POST /api/reviews → server creates session + DB record → broadcast REVIEW_STARTED
→ parent useChat sets activeReview → FloatingReviewPanel mounts
→ useChat(childSessionId) → WS RECONNECT → handleReconnect
```

**New flow**:
```
User clicks "Send to Codex" → selects template
→ ChatView locally sets activeReview state (no server call)
→ FloatingReviewPanel mounts with { context, targetAdapter, cwd }
→ FloatingReviewPanel's useChat auto-sends context as first WS QUERY
→ handleQuery → startSession → registerClient → sendMessage (same as normal!)
→ SESSION_CREATED received → useChat has childSessionId
→ POST /api/reviews { parentSessionId, childSessionId, ... } → DB record created
```

Key changes:
- `ChatView.handleReviewSelect`: instead of calling `api.createReview()`, locally mount FloatingReviewPanel with review props
- `FloatingReviewPanel`: receives `initialPrompt` prop, useChat auto-sends it as first QUERY
- After `SESSION_CREATED`, call `api.registerReview()` to persist the DB record

**Files**: `src/components/ChatView.tsx`, `src/components/FloatingReviewPanel.tsx`, `src/hooks/useChat.ts`, `src/lib/api.ts`

### 3. Server — POST /api/reviews simplified

From:
- `adapter.startSession(cwd)` — REMOVE
- `adapter.pasteToSession(childSessionId, markerContext)` — REMOVE
- `sessionReviews.create(...)` — KEEP
- `broadcastReviewStarted(...)` — KEEP (for multi-device sync)
- Returns `{ reviewId, childSessionId }` — childSessionId now comes from client

To:
```
POST /api/reviews (renamed or new endpoint: POST /api/reviews/register)
  Body: { parentSessionId, childSessionId, targetAdapter, anchorMessageId, prompt, title }
  → sessionReviews.create(...)
  → broadcastReviewStarted(parentSessionId, { reviewId, childSessionId, ... })
  → Returns { reviewId }
```

**Files**: `server/index.ts`

### 4. CODETAP_REF marker — already handled

`handleQuery` in `session-manager.ts` already injects `[CODETAP_REF:tempKey]` for non-Claude new sessions. No change needed — the marker injection works naturally through the QUERY flow.

### 5. `pasteToSession` — can be removed from Codex adapter public API

After `sendMessage` handles all content sizes, `pasteToSession` is no longer needed as a separate public method. It can be:
- Removed from the adapter interface
- Or kept as internal helper called by `sendMessage`

The only remaining caller is `POST /api/reviews/:id/send-back` (sends feedback to parent). This also goes through `sendMessage` if we update it.

**Files**: `server/adapters/codex/codex-tmux-adapter.ts`, `server/adapters/codex/index.ts`, `server/adapters/interface.ts`

## Not Changed

- `POST /api/reviews/:id/send-back` — still HTTP (different concern: sending message to an existing session)
- `POST /api/reviews/:id/end` — still HTTP
- `rekeyAliases` — kept as defensive mechanism (handleQuery's registerClient vs hook timing)
- `session-rekeyed` forwarding — kept (still needed for handleQuery flow)

## Verification

1. New Codex session from WebUI — send message, verify response appears
2. Cross-AI Review: click "Send to Codex" → panel opens → Codex responds in panel (same QUERY flow)
3. Send back to parent — verify message appears
4. End review — verify markers appear
5. Reconnect — verify active review restored
