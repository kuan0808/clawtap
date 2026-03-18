# Remaining Session Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete session architecture cleanup: remove pending guessing, remove desktop-discovery, add session API endpoints, update bin/codetap.

**Spec:** `docs/superpowers/specs/2026-03-24-remaining-session-fixes.md`

---

### Task 1: Codex handleSessionStart — remove pending matching, add _pendingHookBodies

**Files:** `server/adapters/codex/codex-tmux-adapter.ts`

- [ ] **Step 1: Add _pendingHookBodies field**

```typescript
private _pendingHookBodies: Map<string, CodexHookBody> = new Map();
```

- [ ] **Step 2: Rewrite handleSessionStart (line 275)**

Replace the entire method body:

```typescript
handleSessionStart(body: CodexHookBody): void {
  const codexUuid = body.session_id;
  if (!codexUuid) return;

  // 1. Already managed
  if (this.sessions.has(codexUuid)) {
    this._applySessionStartBody(codexUuid, body);
    return;
  }

  // 2. Has pending sessions → store hook body, let _watchForTranscript match later
  const hasPending = [...this.sessions.values()].some(s => s._watcherPending);
  if (hasPending) {
    this._pendingHookBodies.set(codexUuid, body);
    return;
  }

  // 3. Not our session → ignore
}
```

Remove the old `pendingSessions.length === 1` block (lines 297-308).
Remove the "desktop/unknown origin" block (lines 309-330).

- [ ] **Step 3: Update _watchForTranscript to read _pendingHookBodies after rekey**

In the `scanOnce` function, after `_rekeyAndRename(sessionId, uuid)` succeeds, check for stored hook body:

```typescript
const hookBody = this._pendingHookBodies.get(uuid);
if (hookBody) {
  this._applySessionStartBody(uuid, hookBody);
  this._pendingHookBodies.delete(uuid);
}
```

- [ ] **Step 4: Add cleanup for _pendingHookBodies**

In `_startSessionCleanup` interval, add a sweep:

```typescript
// Clean up stale pending hook bodies (older than 60s)
const now = Date.now();
for (const [uuid, body] of this._pendingHookBodies) {
  // Use a timestamp field or just clean up all entries periodically
  this._pendingHookBodies.delete(uuid);
}
```

Actually simpler: clean up in _pendingHookBodies when adding — if size > 10, delete oldest. Or just clear all entries older than 60s by storing a timestamp alongside.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: Codex handleSessionStart uses _pendingHookBodies, no pending guessing"
```

---

### Task 2: Remove desktop-discovery from both adapters

**Files:** `server/adapters/claude/tmux-adapter.ts`, `server/adapters/codex/codex-tmux-adapter.ts`

- [ ] **Step 1: Claude — simplify handleSessionStart (line 512)**

Current code (lines 512-539) does:
1. `sessions.has(cliUuid)` → update lastActivity → return
2. List tmux windows → search for `w.command.includes('claude') && !sessions.has(w.name)` → create session

Remove step 2 entirely. The method becomes:

```typescript
async handleSessionStart(body: HookBody): Promise<void> {
  const cliUuid = body.session_id;
  if (!cliUuid) return;

  if (this.sessions.has(cliUuid)) {
    this.sessions.get(cliUuid)!.lastActivity = Date.now();
    return;
  }

  // Unknown UUID — not our session, ignore
}
```

Also remove the `await tmuxManager.listWindows()` call (no longer needed).

- [ ] **Step 2: Codex — verify desktop-discovery already removed in Task 1**

Check that Task 1's rewrite of `handleSessionStart` has no desktop-discovery path.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: remove desktop-discovery from both adapters"
```

---

### Task 3: Add POST /api/sessions/start and /resume endpoints

**Files:** `server/index.ts`

- [ ] **Step 1: Add POST /api/sessions/start**

Place after the existing session endpoints (after DELETE /api/active-sessions/:id):

```typescript
app.post('/api/sessions/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { adapter: adapterName, cwd, model, permissionMode } = req.body;
    if (!cwd) return res.status(400).json({ error: 'cwd required' });

    const adapter = getAdapter(adapterName || DEFAULT_ADAPTER);
    if (!adapter) return res.status(400).json({ error: `Unknown adapter: ${adapterName}` });

    const handle = await adapter.startSession(cwd, { model, permissionMode });

    // Register in sessionAdapterMap so events route correctly
    sessionAdapterMap.set(handle.sessionId, adapterName || DEFAULT_ADAPTER);

    res.json({ sessionId: handle.sessionId });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

Note: import `sessionAdapterMap` — check if it's already accessible. It's a module-level variable in `session-manager.ts`. May need to export a helper function `registerSessionAdapter(sessionId, adapterName)` from session-manager.

Actually, looking at the code: `sessionAdapterMap` is defined in `session-manager.ts` as a module-level const. It's NOT exported. The `handleQuery` function accesses it directly because it's in the same file.

For `server/index.ts` to set it, we need either:
a) Export `sessionAdapterMap` from session-manager.ts
b) Add a `registerSessionAdapter(id, name)` helper exported from session-manager.ts
c) Have `startSession` trigger an event that session-manager listens to

Option (b) is cleanest.

- [ ] **Step 2: Add POST /api/sessions/resume**

```typescript
app.post('/api/sessions/resume', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { sessionId, adapter: adapterName, cwd } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    // Determine adapter if not provided
    let resolvedAdapterName = adapterName;
    if (!resolvedAdapterName) {
      // Try to detect from JSONL file location
      // ... (use existing findSessionFile logic from each adapter's jsonl-store)
      resolvedAdapterName = DEFAULT_ADAPTER;
    }

    const adapter = getAdapter(resolvedAdapterName);
    if (!adapter) return res.status(400).json({ error: `Unknown adapter: ${resolvedAdapterName}` });

    const handle = await adapter.resumeSession(sessionId, cwd || process.cwd());

    registerSessionAdapter(handle.sessionId, resolvedAdapterName);

    res.json({ sessionId: handle.sessionId });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

- [ ] **Step 3: Export registerSessionAdapter from session-manager.ts**

```typescript
export function registerSessionAdapter(sessionId: string, adapterName: string): void {
  sessionAdapterMap.set(sessionId, adapterName);
}
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add POST /api/sessions/start and /resume endpoints"
```

---

### Task 4: Update bin/codetap to use API endpoints

**Files:** `bin/codetap`

NOTE: `sqlite3` references were already removed in Fix 5. This task replaces direct `tmux new-window` calls with API calls.

- [ ] **Step 1: Add authentication function**

Near the top of the script (after the server-running check):

```bash
get_auth_token() {
  curl -sk -X POST "https://localhost:$PORT/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$CLAUDE_UI_PASSWORD\"}" 2>/dev/null | \
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}
```

- [ ] **Step 2: Replace `new` session creation**

Find the block that does `tmux new-window ... "$COMMAND"`. Replace with:

```bash
AUTH_TOKEN=$(get_auth_token)
if [ -z "$AUTH_TOKEN" ]; then
  echo "Error: Failed to authenticate with CodeTap server"
  exit 1
fi

RESULT=$(curl -sk -X POST "https://localhost:$PORT/api/sessions/start" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"adapter\":\"$ADAPTER\",\"cwd\":\"$(pwd)\"}")
SESSION_ID=$(echo "$RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sessionId",""))' 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo "Error: Failed to create session"
  echo "$RESULT"
  exit 1
fi

tmux select-window -t "$TMUX_SESSION:$SESSION_ID"
```

- [ ] **Step 3: Replace `--resume` with API call**

```bash
AUTH_TOKEN=$(get_auth_token)
RESULT=$(curl -sk -X POST "https://localhost:$PORT/api/sessions/resume" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$RESUME_ID\",\"adapter\":\"$ADAPTER\",\"cwd\":\"$(pwd)\"}")
SESSION_ID=$(echo "$RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sessionId",""))' 2>/dev/null)
tmux select-window -t "$TMUX_SESSION:$SESSION_ID"
```

- [ ] **Step 4: Replace `--continue`**

Find most recent tmux window, resume it:

```bash
LATEST=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_activity} #{window_name}' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
if [ -n "$LATEST" ] && [ "$LATEST" != "main" ]; then
  tmux select-window -t "$TMUX_SESSION:$LATEST"
else
  echo "No active sessions to continue"
  exit 1
fi
```

- [ ] **Step 5: Verify -a listing uses tmux directly**

Should already be tmux-based (from Fix 5). Verify no remaining sqlite3 references.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor: bin/codetap uses API endpoints for session creation"
```

---

## Self-Review Checklist

### Compilation safety
- Task 1 changes only Codex adapter internals → compiles independently ✅
- Task 2 simplifies Claude handleSessionStart → compiles independently ✅
- Task 3 adds new endpoints, needs `registerSessionAdapter` export → export first, then add endpoints ✅
- Task 4 is shell script only → no compilation ✅

### Codex _watchForTranscript flow after Task 1
```
1. startSession → temp key in Map, _watcherPending = true
2. pasteToSession → marker + prompt pasted
3. SessionStart hook fires → has pending → stored in _pendingHookBodies
4. _watchForTranscript detects JSONL → reads marker → matches temp key
5. _rekeyAndRename(tempKey, uuid) → rekey + rename
6. Read _pendingHookBodies(uuid) → apply transcript_path, cwd
7. Start JSONL watcher
```
All steps covered ✅

### Claude handleSessionStart after Task 2
```
handleSessionStart(body):
  sessions.has(uuid) → true → update → return
  → false → ignore
```
Two lines. Very simple. No matching, no discovery. ✅

### bin/codetap after Task 4
- `new`: API call → tmux select-window ✅
- `--resume`: API call → tmux select-window ✅
- `--continue`: tmux list-windows → select most recent ✅
- `-a`: tmux list-windows directly ✅
- No sqlite3 references ✅
- Requires server running + password (already a requirement) ✅

### Edge cases
- **bin/codetap when server is down:** API calls fail → script shows error → user knows server needs to be running. This is acceptable since CodeTap server is required for all functionality.
- **Multiple pending sessions with same UUID in _pendingHookBodies:** Won't happen — UUIDs are unique per CLI session.
- **_pendingHookBodies grows unbounded:** Mitigated by cleanup in _startSessionCleanup (60s sweep).
- **bin/codetap Codex new session — temp key returned:** Script does `tmux select-window -t codetap:codex-{timestamp}`. After rekey, window renamed to UUID. User is already inside — unaffected.

### No changes needed
- `server/session-manager.ts` — only needs `registerSessionAdapter` export (Task 3)
- `server/db.ts` — no changes
- Frontend — no changes
- `server/adapters/claude/tmux-manager.ts` — no changes

## Verification

1. Server starts cleanly
2. New Codex session from Web UI → hook stored in _pendingHookBodies → _watchForTranscript matches → rekey
3. New Claude session from Web UI → works (no matching needed)
4. `bin/codetap new --adapter claude` → API call → session created → window selected
5. `bin/codetap new --adapter codex` → API call → session created → window selected
6. `bin/codetap --resume UUID` → API call → session resumed
7. `bin/codetap -a` → lists sessions from tmux
8. Desktop-started sessions (user runs `claude`/`codex` directly) → hooks ignored by CodeTap (expected)
