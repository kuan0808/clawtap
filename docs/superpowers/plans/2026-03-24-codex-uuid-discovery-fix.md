# Codex UUID Discovery Fix + Session Architecture Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Codex startSession deadlock, replace guess-based matching with JSONL marker matching, kill tmux windows on shutdown, remove DB sessions table.

**Architecture:** 6 tasks: (1) remove _waitForCliUUID + add marker matching in Codex adapter, (2) inject marker in session-manager + index.ts, (3) filter marker in frontend, (4) shutdown kills tmux + remove _findAndAttachWindow, (5) remove DB sessions table, (6) simplify handleReconnect + review endpoints.

**Spec:** `docs/superpowers/specs/2026-03-24-codex-uuid-discovery-fix.md`

---

### Task 1: Codex adapter — remove deadlock, add marker matching

**Files:**
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`

- [ ] **Step 1: Delete `_waitForCliUUID` method**

Remove the entire method. Also remove the call to it in `startSession()` and the `renameWindow` call after it. `startSession` now returns temp key immediately:

```typescript
return { sessionId: tempName };
```

- [ ] **Step 2: Delete `_rekeySession` method (if still exists from earlier)**

This was added in a previous fix. Will be replaced by `_rekeyAndRename`.

- [ ] **Step 3: Add `_rekeyAndRename` method**

```typescript
private async _rekeyAndRename(tempKey: string, cliUuid: string): Promise<void> {
  const session = this.sessions.get(tempKey);
  if (!session) return;
  session.cliSessionId = cliUuid;
  session._watcherPending = false;
  this.sessions.delete(tempKey);
  this.sessions.set(cliUuid, session);
  await tmuxManager.renameWindow(session.windowId, cliUuid);
  if (session.monitor) {
    (session.monitor as any).sessionId = cliUuid;
  }
}
```

Note: NO `dbSessions` calls here — DB sessions table will be removed in Task 5.

- [ ] **Step 4: Add `_matchByTranscriptMarker` method**

Reads JSONL at given path, finds `[CODETAP_REF:xxx]` in first user message, returns `xxx` if it's a key in `this.sessions`:

```typescript
private _matchByTranscriptMarker(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Check for user message content containing marker
        // NOTE: Read codex transcript-parser.ts to get correct field names
        const text = this._extractTextFromEntry(entry);
        if (text) {
          const match = text.match(/\[CODETAP_REF:([^\]]+)\]/);
          if (match && this.sessions.has(match[1])) return match[1];
        }
      } catch {}
    }
  } catch {}
  return null;
}
```

Add a helper `_extractTextFromEntry` that handles the Codex JSONL format (check `transcript-parser.ts` for the actual field structure).

- [ ] **Step 5: Rewrite `handleSessionStart` matching**

Replace `pendingSessions.length === 1` logic:

```
1. Direct lookup: this.sessions.has(codexUuid) → already managed → update state, return
2. Marker matching: _matchByTranscriptMarker(body.transcript_path) → found tempKey → _rekeyAndRename(tempKey, codexUuid), start watcher, return
3. Fallback pending scan: pendingSessions.length === 1 → legacy (kept for sessions without marker)
4. No match: create session entry for this UUID (desktop/unknown origin)
```

In step 4, do NOT call `_findAndAttachWindow` (will be deleted in Task 4). Instead, try matching by tmux window name:

```typescript
const windows = await tmuxManager.listWindows();
const match = windows.find(w => w.name === codexUuid);
if (match) {
  session.windowId = match.id;
  this._startMonitor(codexUuid, match.id);
}
```

- [ ] **Step 6: Update `_watchForTranscript` with marker verification**

In `scanOnce`, after finding a JSONL file candidate, verify it belongs to this session:

```typescript
const firstChunk = readFileSync(fullPath, 'utf8').slice(0, 2000);
if (!firstChunk.includes(`CODETAP_REF:${sessionId}`)) continue;
```

When match confirmed, call `_rekeyAndRename(sessionId, uuid)`.

- [ ] **Step 7: Commit**

```bash
git add server/adapters/codex/codex-tmux-adapter.ts
git commit -m "fix: remove _waitForCliUUID deadlock, add marker-based matching"
```

---

### Task 2: Inject CODETAP_REF marker in session-manager + index.ts

**Files:**
- Modify: `server/session-manager.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Inject marker in handleQuery for new sessions**

In `handleQuery()`, after `startSession` returns and before `sendMessage`:

```typescript
let messageText = prompt;
if (!sessionId) {
  // New session — prepend marker for Codex UUID matching
  messageText = `[CODETAP_REF:${handle.sessionId}]\n${prompt}`;
}
await adapter.sendMessage(handle.sessionId, messageText, { clientId: conn.clientId });
```

For Claude, `handle.sessionId` is already a UUID — marker is harmless, just filtered out in ChatView.

- [ ] **Step 2: Inject marker in POST /api/reviews context**

```typescript
if (context) {
  const markerContext = `[CODETAP_REF:${handle.sessionId}]\n${context}`;
  await adapter.pasteToSession(handle.sessionId, markerContext);
}
```

- [ ] **Step 3: Commit**

```bash
git add server/session-manager.ts server/index.ts
git commit -m "feat: inject CODETAP_REF marker in first message for UUID matching"
```

---

### Task 3: Filter marker in frontend

**Files:**
- Modify: `src/lib/content-utils.ts`
- Modify: `src/hooks/useChat.ts`

- [ ] **Step 1: Add stripMarker to content-utils.ts**

```typescript
const CODETAP_REF_REGEX = /^\[CODETAP_REF:[^\]]+\]\n?/;

export function stripMarker(text: string): string {
  return text.replace(CODETAP_REF_REGEX, '');
}
```

- [ ] **Step 2: Strip marker in convertMessages (useChat.ts)**

Import `stripMarker` from `@/lib/content-utils`. In `convertMessages()`, when processing user messages, strip marker from text content blocks:

```typescript
if (msg.role === 'user') {
  const content = typeof msg.content === 'string'
    ? [{ type: 'text', text: stripMarker(msg.content) }]
    : (msg.content || []).map((b: any) =>
        b.type === 'text' ? { ...b, text: stripMarker(b.text || '') } : b
      );
  // ... rest of processing
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/content-utils.ts src/hooks/useChat.ts
git commit -m "feat: strip CODETAP_REF marker from user messages in ChatView"
```

---

### Task 4: Shutdown kills tmux + remove _findAndAttachWindow

**Files:**
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`

- [ ] **Step 1: Codex destroy() kills tmux session**

Claude's `destroy()` already has `tmuxManager.killSession()` (added in earlier task). Add the same to Codex's `destroy()`:

```typescript
await tmuxManager.killSession();
```

Note: Both adapters share the same tmuxManager. Calling `killSession()` twice is harmless (catch block swallows error).

- [ ] **Step 3: Delete _findAndAttachWindow from Codex adapter**

Remove the entire `_findAndAttachWindow` method. Remove all call sites (in `handleSessionStart` fallback path).

- [ ] **Step 4: Commit**

```bash
git add server/adapters/claude/tmux-adapter.ts server/adapters/codex/codex-tmux-adapter.ts
git commit -m "feat: shutdown kills tmux windows, remove _findAndAttachWindow"
```

---

### Task 5: Remove DB sessions table

**Files:**
- Modify: `server/db.ts`
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`
- Modify: `server/session-manager.ts`
- Modify: `server/index.ts`
- Modify: `bin/codetap`

- [ ] **Step 1: Add parent_adapter to session_reviews table**

In `server/db.ts`, add `parent_adapter TEXT NOT NULL DEFAULT 'claude'` to the `session_reviews` CREATE TABLE.

Add migration: if `parent_adapter` column doesn't exist, add it:
```sql
ALTER TABLE session_reviews ADD COLUMN parent_adapter TEXT NOT NULL DEFAULT 'claude';
```

Update `SessionReviewRow` interface to include `parent_adapter: string`.

Update `sessionReviews.create()` to accept and store `parentAdapter`.

Update `POST /api/reviews` in `server/index.ts` to pass the parent's adapter name when creating a review.

- [ ] **Step 2: Remove sessions table from db.ts**

Delete:
- `CREATE TABLE IF NOT EXISTS sessions` from initDB
- Old schema detection/drop logic (`PRAGMA table_info`, `hasOldColumns`)
- `sessionsUpsert`, `sessionsGet`, `sessionsFindByWindowId`, `sessionsRemove`, `sessionsGetAll` prepared statements from `PreparedStatements` interface and `stmts()` function
- `SessionRow` interface
- `sessions` export object
- `CREATE INDEX idx_sessions_window`

Keep: everything related to `session_reviews`.

- [ ] **Step 2: Remove all dbSessions calls from Claude adapter**

Grep for `dbSessions` in `tmux-adapter.ts`. Remove every call (9 sites):
- `dbSessions.upsert(...)` in startSession (line 131), attachSession (line 181), resumeSession (line 224), handleSessionStart (line 547)
- `dbSessions.remove(...)` in handleSessionEnd (line 500), cleanup loop (line 707)
- `dbSessions.get(...)` in handleSessionStart (line 532), _findWindowForSession (line 875)

Also remove the `import { sessions as dbSessions } from '../../db.js'` line.

NOTE: `_findWindowForSession` currently does `dbSessions.get(sessionId)` first, then falls back to `windows.find(w => w.name === sessionId)`. After removing DB, keep ONLY the window name matching fallback.

- [ ] **Step 3: Remove all dbSessions calls from Codex adapter**

Same pattern. Grep and remove all `dbSessions.*` calls. Remove import.

- [ ] **Step 4: Remove dbSessions from session-manager.ts**

Remove:
- `import { sessions as dbSessions } from './db.js'` (keep `sessionReviews` import)
- `dbSessions.get(sessionId)` in handleReconnect (cwd lookup — no longer needed)
- `dbSessions.get(review.parent_cli_session_id)` in review restoration (Task 6 changes this)

- [ ] **Step 5: Remove dbSessions from index.ts**

Remove:
- `dbSessions.clearAll()` from shutdown handler
- `dbSessions.get(parentCliSessionId)` from review endpoints (Task 6 changes these)
- Import of `sessions as dbSessions`

- [ ] **Step 6: Update bin/codetap**

Remove all SQL queries that reference the `sessions` table:
- `get_project_sessions()` function — queries sessions by cwd
- `-a` listing block — queries sessions by window name
- `--resume` block — queries sessions by id

These CLI features will stop working without the DB. Options:
a) Remove these features from bin/codetap (they depend on DB)
b) Use tmux list-windows directly instead of DB queries

Recommended: option (b) — replace DB queries with tmux-based queries:

`get_project_sessions()`:
```bash
tmux list-windows -t codetap -F '#{window_name}\t#{pane_current_path}' 2>/dev/null | \
  awk -F'\t' -v cwd="$CWD" '$2 == cwd { print $1 }'
```

`-a` listing:
```bash
tmux list-windows -t codetap -F '#{window_name}\t#{pane_current_command}\t#{pane_current_path}' 2>/dev/null
# window_name = UUID, pane_current_command = "claude" or "codex" (adapter detection)
```

`--resume`:
```bash
# Check if UUID exists as a tmux window name
tmux list-windows -t codetap -F '#{window_name}' 2>/dev/null | grep -q "^${RESUME_ID}$"
# Detect adapter from pane command
ADAPTER=$(tmux display -t "codetap:${RESUME_ID}" -p '#{pane_current_command}' 2>/dev/null)
```

- [ ] **Step 7: TypeScript compilation check**

`npx tsc --noEmit` — zero errors.

- [ ] **Step 8: Commit**

```bash
git add server/db.ts server/adapters/claude/tmux-adapter.ts server/adapters/codex/codex-tmux-adapter.ts server/session-manager.ts server/index.ts bin/codetap
git commit -m "refactor: remove DB sessions table — in-memory Map is sole source of truth"
```

---

### Task 6: Simplify handleReconnect + review endpoints use Map for cwd

**Files:**
- Modify: `server/session-manager.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Simplify handleReconnect**

Remove the entire `hasActiveWindow` + `resumeSession` block:

```typescript
// BEFORE:
if (!adapter.getSession(sessionId)) {
  const hasWindow = await adapter.hasActiveWindow(sessionId);
  if (hasWindow) {
    const dbRow = dbSessions.get(sessionId);
    try { await adapter.resumeSession(sessionId, dbRow?.cwd || ''); } catch {}
  }
}

// AFTER:
// (deleted — handleReconnect only loads history, handleQuery builds windows)
```

- [ ] **Step 2: Review endpoints use adapter.getSession for cwd**

In POST /api/reviews:
```typescript
// BEFORE:
const parentRow = dbSessions.get(parentCliSessionId);
const cwd = parentRow?.cwd || process.cwd();

// AFTER:
const parentSession = adapter.getSession(parentCliSessionId) as { cwd?: string } | null;
const cwd = parentSession?.cwd || process.cwd();
```

In POST /api/reviews/:id/send-back and DELETE /api/reviews/:id:
```typescript
// BEFORE:
const parentRow = dbSessions.get(review.parent_cli_session_id);
const parentAdapter = getAdapter(parentRow?.adapter || DEFAULT_ADAPTER);

// AFTER: parent_adapter is now stored in session_reviews
const parentAdapter = getAdapter(review.parent_adapter);
```

No need to iterate adapters — `parent_adapter` is directly in the review row.

In handleReconnect review restoration:
```typescript
// BEFORE:
const parentRow = dbSessions.get(review.parent_cli_session_id);
const cwd = parentRow?.cwd || '';
await childAdapterObj.resumeSession(review.child_cli_session_id, cwd);

// AFTER: don't call resumeSession — if server didn't restart, child is still in Map.
// If server restarted, windows are dead, review should be marked ended.
if (!childAdapterObj.getSession(review.child_cli_session_id)) {
  // Child session gone (server restarted + windows killed) → mark review ended
  sessionReviews.endReview(review.id);
  continue;
}
// Child still alive → just send REVIEW_STARTED event, child's useChat reconnects itself
```

- [ ] **Step 3: Commit**

```bash
git add server/session-manager.ts server/index.ts
git commit -m "refactor: handleReconnect simplified, review endpoints use in-memory Map"
```

---

## Self-Review Checklist

### Compilation Safety
- Task 1 removes `_waitForCliUUID` calls → `startSession` returns temp key → compiles ✅
- Task 5 removes dbSessions → all callers must be updated in same task → grep to verify zero remaining references ✅
- Task 6 depends on Task 5 (dbSessions already removed) → correct ordering ✅

### Codex UUID Discovery Flow (after fix)
```
1. startSession → return tempKey immediately
2. handleQuery/reviews → paste [CODETAP_REF:tempKey] + prompt
3. Codex processes → SessionStart hook fires (or JSONL appears)
4. handleSessionStart → read JSONL → find CODETAP_REF:tempKey → match
5. _rekeyAndRename(tempKey, uuid) → Map re-key + tmux rename
6. From now on: session ID = UUID = tmux window name
```

### handleReconnect Flow (after fix)
```
User clicks session → RECONNECT
1. registerClient(conn, sessionId)
2. load JSONL history → HISTORY_LOAD
3. replay pending state
4. NO resumeSession, NO cwd lookup, NO DB query
5. If user sends message → handleQuery → resumeSession → builds tmux window
```

### Review Endpoints (after fix)
- POST /api/reviews: `cwd` from `adapter.getSession(parentId).cwd` (parent is active, must be in Map)
- send-back: find parent adapter by iterating `getAllAdapters()`, check `adapter.getSession(reviewParentId)`
- delete: same pattern

### bin/codetap (after fix)
- `-a` listing: `tmux list-windows` directly instead of DB query
- `--resume`: `tmux list-windows` to find window by name (= UUID)
- `get_project_sessions`: `tmux list-windows` + filter by `pane_current_path`

### Things NOT changed
- `session_reviews` DB table — stays (Cross-AI Review needs it)
- In-memory `sessions` Map — stays (runtime state store)
- JSONL files — untouched (historical record)
- Push notifications — untouched
- Permission manager — untouched

### Issues Found in Self-Review (all addressed in plan)
- Claude's `destroy()` already has `killSession()` — only Codex needs it added (Task 4 updated)
- Claude's `_findWindowForSession` has DB-first check — keep only name-matching fallback (Task 5 Step 2 noted)
- Review restoration in handleReconnect: don't call `resumeSession`, just check if child exists or mark ended (Task 6 Step 2 updated)
- `send-back`/`delete` review endpoints: added `parent_adapter` column to `session_reviews` — direct lookup, no iteration (Task 5 Step 1)
- `bin/codetap --resume` detects adapter from `pane_current_command` (Task 5 Step 6 updated)
- dbSessions has 26 call sites across 4 files — all enumerated in Task 5

## Verification

1. Server starts without sessions table in DB
2. New Claude session from Web UI → works (marker injected, UUID known immediately)
3. New Codex session from Web UI → works (marker injected, UUID discovered via hook, tmux renamed)
4. Cross-AI Review → works (marker in context, child session matched, floating panel opens)
5. Server shutdown → all tmux windows killed
6. Server restart → clean state, no stale windows
7. `bin/codetap -a` → lists sessions from tmux directly
8. `bin/codetap --resume <UUID>` → works
9. Historical session click → loads history (no 30s wait, no resumeSession)
10. ChatView shows no `[CODETAP_REF:...]` markers
