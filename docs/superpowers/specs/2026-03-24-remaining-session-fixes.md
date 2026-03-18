# Remaining Session Fixes

## Context

Items A, B, C, F, G, H, J, K, L, M were already implemented in earlier commits. The following 4 items remain. CLI internal `/resume` command handling is deferred (Codex doesn't support it, Claude's case is rare).

## D. handleSessionStart — remove pending matching, add _pendingHookBodies

**Current:** `handleSessionStart` has `pendingSessions.length === 1` guessing logic to match a hook to a pending session.

**Problem:** This fails with multiple pending sessions. The marker matching also can't work here because `SessionStart` hook fires at CLI startup, BEFORE the marker is pasted into the JSONL.

**Fix:** `handleSessionStart` does NOT match pending sessions:

```
handleSessionStart(body):
  1. sessions.has(uuid) → already managed → update state → return
  2. has pending sessions → store hook body in _pendingHookBodies Map → return
  3. no pending sessions → ignore → return
```

New `_pendingHookBodies: Map<string, CodexHookBody>` stores hook info (uuid, transcript_path, cwd). When `_watchForTranscript` later matches via marker and calls `_rekeyAndRename`, it reads `_pendingHookBodies.get(uuid)` to get the stored info.

**Cleanup:** `_pendingHookBodies` entries should be cleaned up after 60 seconds if unmatched (timer per entry, or sweep in `_startSessionCleanup`).

**Files:** `server/adapters/codex/codex-tmux-adapter.ts`

## E. Remove desktop-discovery from BOTH adapters

**Current:** Both adapters' `handleSessionStart` create session entries for unknown UUIDs.
- Claude: searches for "unmanaged tmux window running claude" (`w.command.includes('claude')`)
- Codex: creates entry and calls `_findAndAttachWindow` (already removed but fallback path remains)

**Why remove:** With server shutdown killing all tmux windows, and `bin/codetap` moving to API calls, there are no "desktop-started" sessions in the codetap tmux session. Every session should go through `startSession` or `resumeSession`.

**Fix:**
- Claude `handleSessionStart`: remove the "find unmanaged tmux window" block. Keep only `sessions.has(uuid) → update → return`. Unknown UUIDs are ignored.
- Codex `handleSessionStart`: the "desktop-started" branch becomes "ignore" (Task D already handles this).

**Files:** `server/adapters/claude/tmux-adapter.ts`, `server/adapters/codex/codex-tmux-adapter.ts`

## I. New API endpoints for bin/codetap

**Current:** `bin/codetap` creates tmux windows directly, bypassing the server. Sessions it creates don't appear in the Map.

**Fix:** Add two REST endpoints:

```
POST /api/sessions/start
  Body: { adapter, cwd, model?, permissionMode? }
  → adapter.startSession(cwd, options)
  → Returns: { sessionId }

POST /api/sessions/resume
  Body: { sessionId, adapter?, cwd }
  → adapter.resumeSession(sessionId, cwd)
  → Returns: { sessionId }
```

Both require `authMiddleware`.

For `/resume`, if `adapter` is not provided, detect from JSONL file location:
- `~/.claude/projects/.../{UUID}.jsonl` → claude
- `~/.codex/sessions/.../*-{UUID}.jsonl` → codex

**Authentication for bin/codetap:** The script needs a token. It can get one via:
```bash
TOKEN=$(curl -sk -X POST https://localhost:$PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$CLAUDE_UI_PASSWORD\"}")
```

`CLAUDE_UI_PASSWORD` is already required as an env var.

**Files:** `server/index.ts`

## N. Update bin/codetap to use API endpoints

**Fix:**

- `bin/codetap new` → authenticate → `POST /api/sessions/start` → `tmux select-window`
- `bin/codetap --resume UUID` → authenticate → `POST /api/sessions/resume` → `tmux select-window`
- `bin/codetap --continue` → find most recent window from tmux → resume via API
- `bin/codetap -a` → `tmux list-windows` directly (adapter detected from `pane_current_command`)
- Remove ALL `sqlite3` references and `CODETAP_DB` variable

**Note for Codex sessions:** `POST /api/sessions/start` returns temp key (`codex-{timestamp}`). The script does `tmux select-window -t codetap:codex-{timestamp}`. The user is in the window. After rekey, the window name changes to UUID, but the user is unaffected (already inside).

**Files:** `bin/codetap`

## Files Affected

| File | Changes |
|------|---------|
| `server/adapters/codex/codex-tmux-adapter.ts` | D: _pendingHookBodies + rewrite handleSessionStart |
| `server/adapters/claude/tmux-adapter.ts` | E: remove desktop-discovery from handleSessionStart |
| `server/index.ts` | I: add session start/resume endpoints |
| `bin/codetap` | N: use API calls, remove sqlite3 |

## Not Included

- CLI internal `/resume` handling — Codex doesn't support it, Claude's case is rare and non-breaking
- Shared `TmuxAdapterBase` class — deferred to future refactor
- `childCliSessionId` removal from WS protocol — deferred (TODO in code)
