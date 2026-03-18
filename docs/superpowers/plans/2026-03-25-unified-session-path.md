# Unified Session Creation Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Cross-AI Review child session creation to use the same WS QUERY path as normal sessions, eliminating the HTTP-creates-session / WS-reconnects split.

**Spec:** `docs/superpowers/specs/2026-03-25-unified-session-path-design.md`

**Architecture:** Merge `sendMessage` and `pasteToSession` in BOTH adapters (Codex + Claude) so QUERY handles any content size. Move session creation from POST /api/reviews to FloatingReviewPanel's useChat QUERY. POST /api/reviews becomes a registration-only endpoint called after the session exists.

---

## Edge Cases & Scenarios

Before reading the tasks, understand all scenarios this plan must handle:

| # | Scenario | Path | Notes |
|---|----------|------|-------|
| A | Normal Codex session from WebUI | QUERY → handleQuery → startSession → registerClient → sendMessage | ✅ Already works |
| B | Cross-AI Review child (same device) | QUERY → handleQuery (same as A) → then POST /api/reviews/register | ✅ New unified path |
| C | Multi-device: other device connects to parent with active review | RECONNECT → handleReconnect loads active reviews → REVIEW_STARTED → FloatingReviewPanel mounts → RECONNECT to child | ⚠️ RECONNECT path must be preserved |
| D | Page refresh: reconnect to parent + active review | Same as C | ⚠️ RECONNECT path must be preserved |
| E | registerReview POST fails after session created | Session exists but no DB record → retry or show error | ⚠️ Error handling needed |
| F | User clicks End before registerReview completes | reviewId is empty → must not call endReview('') | ⚠️ Guard needed |
| G | Send-back to Claude parent | Claude sendMessage must handle large multiline text | ⚠️ Claude merge needed |
| H | Send-back to Codex parent | Codex sendMessage already handles (Task 1) | ✅ |
| I | CODETAP_REF marker injection | handleQuery injects for non-Claude → sendMessage auto-splits | ✅ |

**Key constraint: RECONNECT path must be preserved** for scenarios C and D. FloatingReviewPanel must support BOTH:
- New path: `initialPrompt` provided, no `childSessionId` → useChat QUERY (creates session)
- Reconnect path: `childSessionId` provided, no `initialPrompt` → useChat RECONNECT (joins existing session)

---

### Task 1: Merge sendMessage and pasteToSession in BOTH adapters

**Files:**
- `server/adapters/codex/codex-tmux-adapter.ts`
- `server/adapters/codex/index.ts`
- `server/adapters/claude/tmux-adapter.ts`
- `server/adapters/claude/index.ts`

This task is standalone — makes `sendMessage` handle all content sizes in both adapters without breaking anything.

- [ ] **Step 1: Rewrite Codex `sendMessage()` (lines 204-221)**

Merge the logic from `pasteToSession()` (lines 223-258) into `sendMessage()`:

```typescript
async sendMessage(sessionId: string, text: string, options: QueryOptions = {}): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  session._promptSenderClientId = options.clientId || null;
  session.isProcessing = true;

  // Restart pane monitor if it was stopped
  if (!session.monitor) {
    this._startMonitor(sessionId, session.windowId);
  }

  // Large or multiline content: use pasteBuffer (fast, handles newlines)
  if (text.length > 500 || text.includes('\n')) {
    const singleLine = text.replace(/\n/g, '\\n');

    // Fresh Codex sessions have TUI placeholder text. If content starts with
    // CODETAP_REF marker, send marker via sendKeys first (clears placeholder),
    // then pasteBuffer the rest.
    const markerMatch = singleLine.match(/^\[CODETAP_REF:[^\]]+\]/);
    if (markerMatch) {
      const marker = markerMatch[0];
      const rest = singleLine.substring(marker.length);
      await tmuxManager.sendKeys(session.windowId, marker, false);
      await new Promise<void>(r => setTimeout(r, 200));
      if (rest) {
        await tmuxManager.pasteBuffer(session.windowId, rest, false);
      }
    } else {
      await tmuxManager.pasteBuffer(session.windowId, singleLine, false);
    }
    await new Promise<void>(r => setTimeout(r, 300));
    await tmuxManager.sendControl(session.windowId, 'Enter');
  } else {
    // Short text: sendKeys (character-by-character)
    await tmuxManager.sendKeys(session.windowId, text, false);
    await new Promise<void>(r => setTimeout(r, 200));
    await tmuxManager.sendControl(session.windowId, 'Enter');
  }

  // If there are pending hook bodies waiting for marker matching, try now
  if (this._pendingHookBodies.size > 0 && session._watcherPending) {
    this._tryMatchPending(sessionId);
  }
}
```

- [ ] **Step 2: Remove Codex `pasteToSession()` method (lines 223-258)**

Delete the entire method from `CodexTmuxAdapter`.

- [ ] **Step 3: Update `CodexAdapter.pasteToSession` in `server/adapters/codex/index.ts`**

Delegate to sendMessage (keeps public API working until Task 3 removes callers):

```typescript
async pasteToSession(sid: string, content: string): Promise<void> {
  return this._tmux.sendMessage(sid, content);
}
```

- [ ] **Step 4: Update Claude `sendMessage()` in `server/adapters/claude/tmux-adapter.ts`**

Currently Claude's `sendMessage` always uses `sendKeys(text, true)`. Add large content handling:

```typescript
async sendMessage(sessionId: string, text: string, options: QueryOptions = {}): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session._promptSenderClientId = options.clientId || null;
  if (!session.monitor) {
    this._startMonitor(sessionId, session.windowId);
  }

  // Large or multiline content: use pasteBuffer (fast)
  if (text.length > 500 || text.includes('\n')) {
    await tmuxManager.pasteBuffer(session.windowId, text);
  } else {
    await tmuxManager.sendKeys(session.windowId, text, true);
  }
}
```

Note: Claude's `pasteBuffer` already handles Enter (sendEnter defaults to true in tmux-manager). Claude doesn't need `\n` → `\\n` replacement or CODETAP_REF marker splitting (Claude generates its own UUID upfront, no placeholder issue).

- [ ] **Step 5: Update `ClaudeAdapter.pasteToSession` in `server/adapters/claude/index.ts`**

Delegate to sendMessage:

```typescript
async pasteToSession(sid: string, content: string): Promise<void> {
  return this._tmux.sendMessage(sid, content);
}
```

- [ ] **Step 6: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add server/adapters/codex/codex-tmux-adapter.ts server/adapters/codex/index.ts server/adapters/claude/tmux-adapter.ts server/adapters/claude/index.ts
git commit -m "refactor: merge sendMessage and pasteToSession in both adapters — auto-detect large content"
```

---

### Task 2: Add registerReview API endpoint + update frontend

**Files:**
- `server/index.ts` — add POST /api/reviews/register
- `src/lib/api.ts` — add `registerReview()` function
- `src/components/ChatView.tsx` — handleReviewSelect uses local state, calls registerReview after session created
- `src/components/FloatingReviewPanel.tsx` — accept `initialPrompt`, auto-send via QUERY, support RECONNECT for multi-device
- `src/hooks/useChat.ts` — support `initialPrompt` for auto-sending first message

All files change together to maintain compilation.

- [ ] **Step 1: Add `registerReview` to `api.ts`**

```typescript
registerReview: (parentCliSessionId: string, childSessionId: string, targetAdapter: string, anchorMessageId: string, prompt: string, title: string) =>
  request<{ reviewId: string }>('/api/reviews/register', {
    method: 'POST',
    body: JSON.stringify({ parentCliSessionId, childSessionId, targetAdapter, anchorMessageId, prompt, title }),
  }),
```

- [ ] **Step 2: Add POST /api/reviews/register endpoint in `server/index.ts`**

```typescript
app.post('/api/reviews/register', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { parentCliSessionId, childSessionId, targetAdapter, anchorMessageId, prompt, title } = req.body;
    if (!parentCliSessionId || !childSessionId) {
      return res.status(400).json({ error: 'parentCliSessionId and childSessionId required' });
    }

    const parentAdapterName = sessionAdapterMap.get(parentCliSessionId) || DEFAULT_ADAPTER;
    const reviewId = crypto.randomUUID();
    sessionReviews.create(reviewId, parentCliSessionId, childSessionId, targetAdapter, parentAdapterName, anchorMessageId, prompt, title);

    if (!sessionAdapterMap.has(childSessionId)) {
      sessionAdapterMap.set(childSessionId, targetAdapter);
    }

    broadcastReviewStarted(parentCliSessionId, {
      reviewId, childSessionId, childCliSessionId: childSessionId,
      childAdapter: targetAdapter, anchorMessageId, reviewTitle: title,
    });

    res.json({ reviewId });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

- [ ] **Step 3: Update FloatingReviewPanel — dual-path support**

**File:** `src/components/FloatingReviewPanel.tsx`

Update interface to support both paths:

```typescript
interface FloatingReviewPanelProps {
  reviewId?: string;           // empty until registerReview completes (new path)
  childSessionId?: string;     // empty for new session (QUERY), set for reconnect (RECONNECT)
  childAdapter: string;
  reviewTitle?: string;
  panelState: 'expanded' | 'minimized' | 'hidden';
  onPanelStateChange: (state: 'expanded' | 'minimized' | 'hidden') => void;
  onEnd: () => void;
  // New path only:
  initialPrompt?: string;      // review context to auto-send as first QUERY
  cwd?: string;
  onSessionCreated?: (childSessionId: string) => void;
}
```

useChat call:

```typescript
const {
  messages, streaming, liveStatus, toolStatuses,
  sendMessage: chatSendMessage, abort, sessionId: chatSessionId,
} = useChat(
  childSessionId || undefined,    // undefined → new session (QUERY); set → reconnect
  initialPrompt,                  // auto-send as first message (new path only)
  childAdapter,
  cwd,
);

// Notify parent when session is created via QUERY (new path)
const notifiedRef = useRef(false);
useEffect(() => {
  if (chatSessionId && !childSessionId && onSessionCreated && !notifiedRef.current) {
    notifiedRef.current = true;
    onSessionCreated(chatSessionId);
  }
}, [chatSessionId, childSessionId, onSessionCreated]);
```

- [ ] **Step 4: Update useChat — support `initialPrompt` parameter**

**File:** `src/hooks/useChat.ts`

Update signature:

```typescript
export function useChat(
  existingSessionId?: string,
  initialPrompt?: string,
  adapterOverride?: string,
  cwdOverride?: string,
) {
```

Add ref and auto-send in WS onopen:

```typescript
const initialPromptSent = useRef(false);

// In the WS onopen handler, after connection established:
if (initialPrompt && !existingSessionId && !initialPromptSent.current) {
  initialPromptSent.current = true;
  actualSend(initialPrompt);
}
```

**Important:** `actualSend` must pass `adapter: adapterOverride` and `cwd: cwdOverride` in the QUERY options so handleQuery uses the correct adapter and directory.

- [ ] **Step 5: Update ChatView `handleReviewSelect` — local mount + registerReview**

**File:** `src/components/ChatView.tsx`

Add state:

```typescript
const [reviewInitialPrompt, setReviewInitialPrompt] = useState<string | null>(null);
const [reviewCwd, setReviewCwd] = useState<string | null>(null);
```

Replace `api.createReview()` call in handleReviewSelect:

```typescript
// Instead of api.createReview, set local state to mount panel
setActiveReview({
  reviewId: '',
  childSessionId: '',
  childCliSessionId: '',
  childAdapter: targetAdapter,
  anchorMessageId: anchorMsgId,
  reviewTitle: title,
});
setReviewInitialPrompt(cappedContext);
setReviewCwd(/* parent session's cwd from adapterConfig or session state */);
setReviewPanelState('expanded');
```

Update FloatingReviewPanel props:

```tsx
<FloatingReviewPanel
  reviewId={activeReview.reviewId || undefined}
  childSessionId={activeReview.childSessionId || undefined}
  childAdapter={activeReview.childAdapter}
  reviewTitle={activeReview.reviewTitle}
  panelState={reviewPanelState}
  onPanelStateChange={setReviewPanelState}
  onEnd={async () => {
    // Guard: only call endReview if reviewId exists (edge case F)
    if (activeReview.reviewId) {
      try { await api.endReview(activeReview.reviewId); } catch {}
    }
    // Always destroy child session if it exists
    if (activeReview.childSessionId) {
      // session cleanup happens server-side when session ends
    }
    setActiveReview(null);
    setReviewPanelState('hidden');
    setReviewInitialPrompt(null);
  }}
  initialPrompt={reviewInitialPrompt || undefined}
  cwd={reviewCwd || undefined}
  onSessionCreated={async (childSid) => {
    try {
      const result = await api.registerReview(
        sessionId, childSid, activeReview.childAdapter,
        activeReview.anchorMessageId, activeReview.reviewTitle || '', ''
      );
      setActiveReview(prev => prev ? {
        ...prev,
        reviewId: result.reviewId,
        childSessionId: childSid,
        childCliSessionId: childSid,
      } : null);
    } catch (err) {
      // Edge case E: registerReview failed
      console.error('Failed to register review:', err);
      // Session exists but no DB record — user can still chat, just won't persist
    }
    setReviewInitialPrompt(null);
  }}
/>
```

- [ ] **Step 6: Verify RECONNECT path still works (scenarios C/D)**

The RECONNECT path is preserved because:
- When `childSessionId` is provided (from REVIEW_STARTED broadcast on reconnect), useChat sends RECONNECT
- When `initialPrompt` is NOT provided, no auto-send happens
- FloatingReviewPanel renders ChatBody normally with messages from HISTORY_LOAD

Verify by checking: `handleReconnect` in session-manager.ts sends active reviews → useChat REVIEW_STARTED handler sets `activeReview` with `childSessionId` → FloatingReviewPanel mounts with childSessionId → useChat RECONNECT.

- [ ] **Step 7: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add server/index.ts src/lib/api.ts src/components/ChatView.tsx src/components/FloatingReviewPanel.tsx src/hooks/useChat.ts
git commit -m "feat: unified session path — review child uses QUERY, registerReview after session created"
```

---

### Task 3: Clean up — remove old review session creation + pasteToSession

**Files:**
- `server/index.ts`
- `src/lib/api.ts`
- `server/adapters/interface.ts`
- `server/adapters/codex/index.ts`
- `server/adapters/claude/index.ts`
- `server/adapters/claude/tmux-adapter.ts`

- [ ] **Step 1: Remove old POST /api/reviews session creation logic**

In `server/index.ts` POST /api/reviews handler (lines 249-319):
- Remove `adapter.startSession()` call
- Remove `adapter.pasteToSession()` call
- Remove marker injection logic
- Keep only: DB record creation + broadcast (same as /api/reviews/register)
- Or remove the entire endpoint and redirect to /api/reviews/register

Check frontend callers:
```bash
grep -rn "createReview\|/api/reviews'" src/ --include="*.ts" --include="*.tsx"
```

Remove `createReview` from `api.ts` if no longer called.

- [ ] **Step 2: Update send-back to use sendMessage**

In `POST /api/reviews/:id/send-back` (server/index.ts lines 369-371):

```typescript
// OLD:
await parentAdapter.pasteToSession(parentSessionId, formatted);

// NEW:
await parentAdapter.sendMessage(parentSessionId, formatted);
```

Both Claude and Codex `sendMessage` now handle large content (Task 1).

- [ ] **Step 3: Remove `pasteToSession` from adapter interface**

Check remaining callers:
```bash
grep -rn "pasteToSession" server/ --include="*.ts"
```

If no remaining callers after Steps 1-2, remove from:
- `server/adapters/interface.ts` — base class method
- `server/adapters/codex/index.ts` — delegation
- `server/adapters/codex/codex-tmux-adapter.ts` — if any leftover
- `server/adapters/claude/index.ts` — delegation
- `server/adapters/claude/tmux-adapter.ts` — implementation

- [ ] **Step 4: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add server/ src/lib/api.ts
git commit -m "refactor: remove old review session creation and pasteToSession from adapter interface"
```

---

### Task 4: E2E Verification

- [ ] **Step 1: Start server**
```bash
CLAUDE_UI_PASSWORD=TEST npm run dev
```

- [ ] **Step 2: Test normal Codex session (scenario A)**
New Project → code-tap → Codex → send message → verify response + icon buttons.

- [ ] **Step 3: Test normal Claude session**
New Project → code-tap → Claude → send message → verify response.

- [ ] **Step 4: Test Cross-AI Review unified path (scenario B)**
1. Claude session → send message → get response
2. Click send icon → select "Direct send"
3. Verify FloatingReviewPanel opens
4. Verify panel shows Codex response (via QUERY, same as normal)
5. Verify session ID updates to real UUID

- [ ] **Step 5: Test send-back (scenario H)**
In review panel, click send-back icon → verify message appears in parent chat.

- [ ] **Step 6: Test end review**
Click "End" → verify panel closes, markers appear.

- [ ] **Step 7: Test end review before registerReview (scenario F)**
Quick-click End immediately after review starts (before Codex responds) → verify no crash.

- [ ] **Step 8: Test page refresh reconnect (scenario D)**
1. Start a review
2. Refresh page
3. Reconnect to parent session
4. Verify FloatingReviewPanel re-appears with child session (RECONNECT path)

---

## Self-Review Checklist

### Flow comparison after all tasks

```
Normal session (Codex or Claude):
  useChat.actualSend("Hi") → WS QUERY → handleQuery → startSession → registerClient → sendMessage

Review child (same device, scenario B):
  useChat.actualSend(reviewContext) → WS QUERY → handleQuery → startSession → registerClient → sendMessage
  → SESSION_CREATED → POST /api/reviews/register → DB record + broadcast

Review child (other device/reconnect, scenarios C/D):
  REVIEW_STARTED from server → FloatingReviewPanel mounts with childSessionId
  → useChat RECONNECT → handleReconnect → registerClient → HISTORY_LOAD

All three paths work. Scenarios B and normal use IDENTICAL QUERY flow.
```

### Adapter sendMessage unification
| Adapter | Short text | Long/multiline text |
|---------|-----------|-------------------|
| Codex | sendKeys | `\n`→`\\n` + pasteBuffer (with CODETAP_REF marker split) |
| Claude | sendKeys | pasteBuffer (no `\n` replacement needed, no marker split) |

### Error handling
- registerReview failure → catch, log, session continues (no DB record but chat works) ✅
- End with empty reviewId → guard, skip endReview API call ✅
- initialPrompt double-send → ref guard prevents ✅

### Files changed
| File | Change |
|------|--------|
| `server/adapters/codex/codex-tmux-adapter.ts` | Merge sendMessage + pasteToSession |
| `server/adapters/codex/index.ts` | pasteToSession delegates to sendMessage |
| `server/adapters/claude/tmux-adapter.ts` | sendMessage handles large content |
| `server/adapters/claude/index.ts` | pasteToSession delegates to sendMessage |
| `server/adapters/interface.ts` | Remove pasteToSession (Task 3) |
| `server/index.ts` | Add /api/reviews/register, remove old POST /api/reviews session creation |
| `src/lib/api.ts` | Add registerReview(), remove createReview() |
| `src/components/ChatView.tsx` | handleReviewSelect → local state + registerReview callback |
| `src/components/FloatingReviewPanel.tsx` | Dual-path: initialPrompt (QUERY) or childSessionId (RECONNECT) |
| `src/hooks/useChat.ts` | Support initialPrompt auto-send |
