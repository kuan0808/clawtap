# Codex UUID Discovery Fix + Session Architecture Cleanup

## Problems Found

### 1. Deadlock: `_waitForCliUUID` blocks `startSession` (Critical)

`startSession()` calls `_waitForCliUUID()` which polls for `session.cliSessionId` to be set. But the UUID is only set when `handleSessionStart` hook fires, which requires Codex to process a prompt. The prompt is sent AFTER `startSession` returns. Deadlock: 15-second timeout, session creation fails.

Affects both `handleQuery` (new Codex chat from Web UI) and `POST /api/reviews` (Cross-AI Review child session).

### 2. Pending Session Matching by Count (Medium)

`handleSessionStart` matches hook to pending session by checking `pendingSessions.length === 1`. If 0 pending: treated as desktop-started. If 2 pending: neither matches, hook creates a spurious session entry. This is a guess, not a precise match.

### 3. `_findAndAttachWindow` uses `command.includes('codex')` (Medium)

Grabs the first tmux window whose command contains `codex`. If multiple codex windows exist, picks the wrong one. After Session ID Unification, window names are UUIDs, so this method is both incorrect and unnecessary (see solution).

### 4. `_watchForTranscript` matches by recency (Low)

Scans the day directory for JSONL files modified within 120 seconds, picks the first match. If two Codex sessions start simultaneously, can pick the wrong file.

### 5. Server shutdown leaves tmux windows running (Resource waste)

`adapter.destroy()` cleans up monitors and watchers but does NOT kill tmux windows. After server stops, CLI processes continue running in tmux, consuming resources.

### 6. DB sessions table is unnecessary (Complexity)

The `sessions` DB table stores `id`, `cwd`, `window_id`, `adapter`. After the Session ID Unification, all runtime data is in the in-memory `sessions` Map. The DB was used for:
- `_findAndAttachWindow` window recovery after restart: unnecessary if windows are killed on shutdown
- `handleReconnect` cwd lookup for resumeSession: unnecessary if handleReconnect doesn't resume
- Review endpoints cwd lookup: can use in-memory Map instead

## Solution

### A. Remove `_waitForCliUUID` entirely

`startSession()` returns the temp key immediately. UUID discovery happens asynchronously via `handleSessionStart` or `_watchForTranscript`.

### B. CODETAP_REF marker for precise matching

Every first message sent to a new Codex session includes a marker:

```
[CODETAP_REF:codex-1774316492094]
actual prompt or context here...
```

Where `codex-1774316492094` is the temp key (tmux window name at creation time).

**Injection points:**
- `handleQuery` in session-manager.ts: when creating a new session (no existing sessionId), prepend marker to the prompt
- `POST /api/reviews` in index.ts: prepend marker to the context

**Matching in `handleSessionStart`:**
1. Read the JSONL file at `body.transcript_path`
2. Find the first user message
3. Extract `CODETAP_REF:xxx` marker
4. Match `xxx` to a pending session's temp key
5. Call `_rekeyAndRename` to finalize

**Matching in `_watchForTranscript`:**
- After finding a candidate JSONL file, verify it contains `CODETAP_REF:tempKey`

**Frontend filtering:**
- Strip `[CODETAP_REF:...]` from user messages in `convertMessages` (useChat.ts)

### C. `_rekeyAndRename` — finalize UUID discovery

New method called when UUID is discovered (by handleSessionStart or _watchForTranscript):
- Delete temp key from sessions Map
- Set CLI UUID as new key
- Rename tmux window from temp name to CLI UUID
- Update monitor's sessionId

### D. Server shutdown kills all tmux windows

`adapter.destroy()` calls `tmuxManager.killSession()` to kill the entire codetap tmux session. No resource leaks.

### E. Remove `_findAndAttachWindow`

With shutdown killing all windows, no tmux windows survive restart. No need to rediscover windows. Delete the method and all call sites.

### F. Remove DB sessions table

The `sessions` table serves no purpose after changes D and G:
- `_findAndAttachWindow` (deleted in E) was the main consumer
- `handleReconnect` no longer calls `resumeSession` (changed in G)
- Review endpoints get `cwd` from in-memory Map (changed in H)

Delete: CREATE TABLE, prepared statements, SessionRow interface, `sessions` export, all `dbSessions.*` calls across the codebase.

DB retains only `session_reviews` table (for Cross-AI Review).

### G. Simplify `handleReconnect`

Remove the `hasActiveWindow` + `resumeSession` block. After shutdown kills windows, there is no scenario where a session is not in the Map but has an active tmux window.

`handleReconnect` becomes: register client, load JSONL history, replay pending state. Building tmux windows is `handleQuery`'s job (when the user sends a message).

### H. Review endpoints get cwd from Map + add parent_adapter to session_reviews

Replace `dbSessions.get(parentCliSessionId)` with `adapter.getSession(parentCliSessionId)` to get `cwd` from the in-memory Map. The parent session is always active (user is interacting with it) so it is always in the Map.

Add `parent_adapter TEXT NOT NULL` column to `session_reviews` table. Store it when creating a review. This way `send-back` and `delete` endpoints can find the correct adapter directly from the review row, without needing to iterate all adapters or query the sessions DB.

## Files Affected

| File | Changes |
|------|---------|
| `server/adapters/codex/codex-tmux-adapter.ts` | A: remove _waitForCliUUID. B: add _matchByTranscriptMarker. C: add _rekeyAndRename. D: destroy calls killSession. E: remove _findAndAttachWindow. F: remove all dbSessions calls |
| `server/adapters/claude/tmux-adapter.ts` | D: destroy calls killSession. F: remove all dbSessions calls |
| `server/adapters/claude/index.ts` | No change (doesn't use dbSessions directly) |
| `server/adapters/codex/index.ts` | No change |
| `server/session-manager.ts` | B: inject marker in handleQuery. F: remove dbSessions import and calls. G: simplify handleReconnect. H: review restoration uses adapter.getSession for cwd |
| `server/index.ts` | B: inject marker in POST /api/reviews. F: remove dbSessions import, clearAll call in shutdown. H: review endpoints use adapter.getSession for cwd |
| `server/db.ts` | F: delete sessions table schema, SessionRow, prepared statements, sessions export. Keep session_reviews |
| `src/lib/content-utils.ts` | B: add stripMarker function |
| `src/hooks/useChat.ts` | B: strip marker in convertMessages |
| `bin/codetap` | F: remove SQL queries that reference sessions table (get_project_sessions, -a listing, --resume lookup) |
