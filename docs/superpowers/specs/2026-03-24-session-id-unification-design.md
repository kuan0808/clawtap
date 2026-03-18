# Session ID Unification — CLI UUID as Single Source of Truth

## Problem

The codebase has two session ID systems that create bugs and complexity:

1. **Internal ID** (format `claude-1774300056705` / `codex-1774300056705`): tmux window name, in-memory Map key, DB primary key
2. **CLI UUID** (format `d6d56787-bfaf-4312-ae4d-99683ba45459`): permanent ID from the CLI tool, JSONL filename

These require constant translation via `resolveSessionId()` and `cliToSessionId` Maps. When translation fails:

- Mobile can not receive desktop events (registered under CLI UUID, events broadcast under internal ID)
- handleReconnect creates unwanted tmux windows (lost hasActiveWindow guard)
- SessionsView passes different ID types (project list = CLI UUID, active list = internal ID)
- Latent bug: `_registerCliUUID()` references renamed column `claude_session` (should be `cli_session`)

## Solution

Eliminate internal ID as a session identifier. Use CLI UUID everywhere. Internal ID becomes just a tmux window display name with no programmatic significance.

## Design

### Layer 1: Adapter Internals

**Files:** `server/adapters/claude/tmux-adapter.ts`, `server/adapters/codex/codex-tmux-adapter.ts`, `server/adapters/codex/pane-monitor.ts`, `server/adapters/interface.ts`

**`this.sessions` Map key**: internal ID changes to CLI UUID.

**Eliminated entirely:**
- `cliToSessionId: Map<string, string>` -- no translation needed
- `resolveSessionId()` method -- no translation needed
- `_registerCliUUID()` -- no mapping to maintain (also fixes `claude_session` column bug)
- `_remapCliSession()` -- no remapping needed
- `_removeCliMapping()` -- no mapping to clean up

**`startSession()` returns CLI UUID.** The tmux window name remains `{adapter}-{timestamp}` for tmux display but is not used as an identifier.

**`resumeSession()` / `attachSession()`** take CLI UUID as parameter.

**All event emits** use CLI UUID as first argument.

**`getActiveSessions()`** returns CLI UUID as `sessionId`. The `cliSessionId` field kept for compatibility (same value).

**`_findWindowForSession()`** looks up `window_id` from DB by CLI UUID instead of matching tmux window names.

**`handleSessionStart()` pattern matching**: `w.name.startsWith('claude-')` still works because tmux window names retain the `{adapter}-{timestamp}` format.

**Codex `startSession()` UUID timing**: Codex CLI generates its own UUID (arrives via SessionStart hook or JSONL filename). Add `_waitForCliUUID()` that waits for `session.cliSessionId` to be populated (max 15 seconds). Session initially stored under a temporary key (the window name), re-keyed once UUID is known.

During the temp-key window:
- Hooks arriving from CLI use the `_watcherPending` scanning pattern (already exists) to find the session
- Events are emitted under the temp key (few clients would be registered under it yet)
- Once UUID arrives: session is re-keyed in the Map, DB is upserted, `sessionAdapterMap` updated

If `_waitForCliUUID` times out:
- Kill the tmux window (`tmuxManager.killWindow`)
- Remove the temp session from the Map
- Throw error (propagates to client as WS error message)

**Codex `CodexPaneMonitor`**: stores `sessionId` for event emission -- changes from internal ID to CLI UUID.

### Layer 2: DB Schema

**Files:** `server/db.ts`

**`sessions` table migration:**

Before:
- `id` (PRIMARY KEY) = internal ID
- `cli_session` = CLI UUID

After:
- `id` (PRIMARY KEY) = CLI UUID
- `cli_session` column removed
- `window_name` column added (stores old internal ID for tmux display/debug)

**`SessionRow` interface:**

```typescript
export interface SessionRow {
  id: string;                    // CLI UUID (was internal ID)
  cwd: string;
  window_id: string | null;      // tmux window ID (@N)
  window_name: string | null;    // tmux window name for debug
  adapter: string;
  permission_mode: string;
  created_at: string;
  last_activity: string;
}
```

**Prepared statements:**
- `sessionsUpsert(id=cliUUID, cwd, windowId, windowName, adapter)` -- `id` is CLI UUID
- `sessionsFindByCliSession` -- REMOVED (use primary key lookup)
- `sessionsFindByWindowId` -- unchanged
- `sessionsRemove(id)` -- `id` is now CLI UUID
- Add `sessionsGet(id)` -- simple primary key lookup

**`session_reviews` table**: No changes (already uses CLI UUIDs).

**`session_stats` table**: Verify `session_id` uses CLI UUID. Migrate if needed.

**Migration SQL** (SQLite table rebuild pattern):

```sql
-- Step 1: Create new table with new schema
CREATE TABLE IF NOT EXISTS sessions_new (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  window_id TEXT,
  window_name TEXT,
  adapter TEXT DEFAULT 'claude',
  permission_mode TEXT DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  last_activity TEXT DEFAULT (datetime('now'))
);

-- Step 2: Copy data, swapping id and cli_session
-- Skip rows where cli_session is empty, equals the internal ID, or matches {adapter}-{timestamp} pattern
INSERT OR IGNORE INTO sessions_new (id, cwd, window_id, window_name, adapter, permission_mode, created_at, last_activity)
SELECT
  CASE
    WHEN cli_session IS NOT NULL AND cli_session != '' AND cli_session != id THEN cli_session
    ELSE id
  END,
  cwd, window_id, id, adapter, permission_mode, created_at, last_activity
FROM sessions;

-- Step 3: Drop old table and rename
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Step 4: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_sessions_window ON sessions(window_id);
```

Migration is wrapped in a transaction and runs inside `initDB()` before any adapter initialization. Detection: check if the old `cli_session` column exists (`PRAGMA table_info(sessions)`).

**Handling rows where `cli_session` = internal ID**: Some Codex sessions store the internal ID as both `id` and `cli_session` (when UUID wasn't yet known). The migration uses `CASE WHEN cli_session != id THEN cli_session ELSE id END` — these rows keep their internal ID as `id`. They will be orphaned (no JSONL match) and cleaned up naturally by `clearAll()` on next shutdown.

**`session_stats` table**: This table exists in the schema but is never written to by any code in the codebase (no INSERT statements found). It can be left as-is or dropped. No migration needed.

### Layer 3: Session Manager

**Files:** `server/session-manager.ts`

**`sessionClients` Map key**: CLI UUID (was internal ID).
**`sessionAdapterMap` Map key**: CLI UUID (was internal ID).

**`broadcast(sessionId, message)`**: `sessionId` is CLI UUID. This is the core fix -- adapter events emitted with CLI UUID now match client registration keys.

**`sendSessionCreated()`**: Sends single `sessionId` (CLI UUID). Remove `cliSessionId` field.

**`handleQuery()`**: No `resolveSessionId` call. `options.sessionId` from client is CLI UUID directly.

**`handleReconnect()`**: Greatly simplified. No `resolveSessionId` needed. All 11 existing steps preserved:

1. ~~Resolve internal ID via resolveSessionId~~ REMOVED (no translation needed)
2. Register client under CLI UUID
3. Clear push pending notifications (keyed by CLI UUID)
4. Send SESSION_CREATED (single ID)
5. Send cached status
6. Resume if not in memory — **with `hasActiveWindow` guard**:
   ```
   if session not in memory:
     if tmux window exists: resumeSession (attach to monitor events)
     else: do nothing (just load history from JSONL)
   ```
7. Sync watcher position
8. Load JSONL history (`adapter.getMessages(sessionId)` — CLI UUID directly, no cliSessionId extraction needed)
9. Send streaming state (SESSION_STATE)
10. Replay pending tools and permissions
11. Restore active child reviews (`sessionReviews.getActiveForParent(sessionId)` — CLI UUID directly)

Key simplification in step 11: no longer needs `findByCliSession` to look up parent CWD for child session resume — can use `sessions.get(sessionId)` primary key lookup directly (since `id` is now CLI UUID).

**`triggerPush()`**: Simplified — `sessionId` IS CLI UUID, so child review check uses `sessionId` directly (no need to look up `sessionObj.cliSessionId`). Single `getSession()` call replaces the current two calls with different casts. Uses CLI UUID for sessionClients lookup, push pending, and push payload.

**`session-ended` handler**: `sessionId` parameter IS CLI UUID. The entire convoluted lookup (`findByWindowId` fallback + `getAll().find()`) to extract `cli_session` is eliminated — `sessionId` is already the CLI UUID. Cascade cleanup calls `sessionReviews.getActiveForParent(sessionId)` directly. `sessionClients.delete` and `sessionAdapterMap.delete` remain synchronous (before any async cascade work).

**`server/index.ts` active sessions endpoint**: The dual lookup `getClientCount(s.sessionId) || getClientCount(s.cliSessionId)` simplifies to `getClientCount(s.sessionId)` since both are the same CLI UUID.

**`broadcastReviewStarted/Ended`**: `parentSessionId` is CLI UUID.

### Layer 4: Frontend

**Files:** `src/hooks/useChat.ts`, `src/lib/ws.ts`, `src/components/ChatView.tsx`, `src/components/SessionsView.tsx`, `src/components/FloatingReviewPanel.tsx`, `src/lib/api.ts`

**`useChat.ts`**: Merge `sessionId` and `cliSessionId` states into single `sessionId` (always CLI UUID). `SESSION_CREATED` handler sets one state. All outgoing WS messages (QUERY, ABORT, RECONNECT, SET_MODEL, SET_PERMISSION_MODE, PLAN_RESPONSE) send this single `sessionId`.

**`ws.ts`**: `activeSessionId` stores CLI UUID from `SESSION_CREATED`.

**`ChatView.tsx`**: Header shows single `sessionId` (CLI UUID). Review API calls use `sessionId` directly. Remove `cliSessionId` from ChatHeader props.

**`SessionsView.tsx`**: Both session lists (project + active) now use CLI UUID for `session.sessionId`. `onOpenChat(session.sessionId)` is consistent. `destroySession(session.sessionId)` passes CLI UUID. Push pending lookup `pending[session.sessionId]` uses CLI UUID.

**`FloatingReviewPanel.tsx`**: `childSessionId` prop is CLI UUID.

**`ActiveSessionInfo` interface**: `sessionId` becomes CLI UUID. `cliSessionId` kept as deprecated alias (same value).

### Layer 5: Push Notifications + Permissions

**Files:** `server/push.ts`, `server/permission-manager.ts`, `src/sw.ts`, `src/App.tsx`

**`push.ts`**: `pendingSessions` Map keyed by CLI UUID.

**`permission-manager.ts`**: `PendingPermission.sessionId` is CLI UUID. `sessionPendingIds` Map keyed by CLI UUID.

**`sw.ts`**: Push payload `sessionId` is CLI UUID. Notification click URL `/?session=${cliUUID}`.

**`App.tsx`**: URL parameter `?session=` is CLI UUID. Service worker `OPEN_SESSION` message carries CLI UUID.

### Layer 6: CLI (`bin/codetap`)

**File:** `bin/codetap`

DB queries updated to use new schema (no `cli_session` column, `id` is CLI UUID):

- Line 239 `get_project_sessions()`: Change `SELECT id FROM sessions` to `SELECT window_name FROM sessions` — the function returns IDs to match against tmux window names, which are `{adapter}-{timestamp}` format (stored in `window_name`, not `id`)
- Line 290: Change `SELECT id, adapter, cli_session, cwd` to `SELECT id, adapter, window_name, cwd` — display CLI UUID as `id`, use `window_name` for tmux matching
- Line 260: Match tmux window names against `window_name` column (not `id`)
- Line 382 `--resume`: Simplified to `WHERE id='${SAFE_ID}'` since `id` is now CLI UUID
- Window name generation unchanged (`{adapter}-{timestamp}`)

**Critical**: The `-a` listing mode joins tmux window names against DB session IDs. After migration, this join key changes from `id` to `window_name`. The `IN (...)` SQL clause must query `window_name` column.

## Codex UUID Discovery Flow

```
1. handleQuery() -> adapter.startSession(cwd, options)
2. Codex startSession():
   a. Generate window name "codex-{timestamp}"
   b. Create tmux window
   c. Wait for CLI ready (_waitForReady)
   d. Start _watchForTranscript() (sets up FSWatcher)
   e. NEW: _waitForCliUUID() -- wait for session.cliSessionId to be populated
      - Source 1: handleSessionStart hook fires with session_id
      - Source 2: _watchForTranscript detects JSONL file, extracts UUID from filename
   f. Once UUID known: set as Map key, upsert DB
   g. Return { sessionId: cliUUID }
3. handleQuery() continues with cliUUID
4. registerClient, sendSessionCreated, sendMessage -- all use cliUUID
```

Timeout: 15 seconds. If UUID not discovered, startSession fails with error.

## Files Affected (Complete List)

| File | Change Type | Summary |
|------|------------|---------|
| `server/db.ts` | MODIFY | Schema migration, remove cli_session, add window_name, update SessionRow |
| `server/session-manager.ts` | MODIFY | All Map keys to CLI UUID, simplify handleReconnect, fix triggerPush |
| `server/adapters/claude/tmux-adapter.ts` | MODIFY | sessions Map key, eliminate cliToSessionId/resolveSessionId, events use CLI UUID |
| `server/adapters/codex/codex-tmux-adapter.ts` | MODIFY | Same as Claude adapter, add _waitForCliUUID |
| `server/adapters/codex/pane-monitor.ts` | MODIFY | sessionId is CLI UUID |
| `server/adapters/interface.ts` | MODIFY | Remove resolveSessionId, update ActiveSessionInfo |
| `server/adapters/claude/index.ts` | MODIFY | Remove resolveSessionId delegation |
| `server/adapters/codex/index.ts` | MODIFY | Remove resolveSessionId delegation |
| `server/push.ts` | MODIFY | pendingSessions keyed by CLI UUID |
| `server/permission-manager.ts` | MODIFY | All session indices use CLI UUID |
| `server/transport/client-connection.ts` | NO CHANGE | sessionId field semantics change (now CLI UUID) |
| `server/index.ts` | MODIFY | Remove dual-ID lookups in active-sessions, simplify review endpoints |
| `server/types/messages.ts` | MODIFY | QueryOptions.sessionId is CLI UUID |
| `server/types/adapter.ts` | MODIFY | SessionInfo.sessionId is CLI UUID (already was) |
| `server/ws-types.ts` | NO CHANGE | Just message type constants |
| `src/hooks/useChat.ts` | MODIFY | Merge sessionId + cliSessionId into one |
| `src/lib/ws.ts` | MODIFY | activeSessionId stores CLI UUID |
| `src/lib/api.ts` | MODIFY | destroySession passes CLI UUID |
| `src/components/ChatView.tsx` | MODIFY | Single ID in header, remove cliSessionId usage |
| `src/components/SessionsView.tsx` | MODIFY | Consistent CLI UUID for both lists |
| `src/components/FloatingReviewPanel.tsx` | MODIFY | childSessionId is CLI UUID |
| `src/sw.ts` | MODIFY | Push sessionId is CLI UUID |
| `src/App.tsx` | MODIFY | URL param and SW message use CLI UUID |
| `bin/codetap` | MODIFY | DB queries use new schema |
| `server/adapters/claude/jsonl-store.ts` | NO CHANGE | Already uses CLI UUID |
| `server/adapters/codex/jsonl-store.ts` | NO CHANGE | Already uses CLI UUID |
| `server/adapters/claude/pane-monitor.ts` | NO CHANGE | Uses windowId (tmux ID), not session ID |
| `server/adapters/claude/hook-config.ts` | NO CHANGE | No session IDs |
| `server/adapters/codex/hook-config.ts` | NO CHANGE | No session IDs |
| `server/adapters/registry.ts` | NO CHANGE | No session IDs |
| `server/config.ts` | NO CHANGE | No session IDs |
| `server/stores/jsonl-watcher.ts` | NO CHANGE | File path based |
| `src/hooks/useSessions.ts` | MODIFY | `s.cliSessionId` for green dots → `s.sessionId` (same value after unification) |
| `tests/e2e-spec.feature` | MODIFY | Remove references to `resolveSessionId`, `cliSessionId` dual-ID |

## What This Fixes

1. Mobile receives desktop events in real-time (same broadcast key)
2. handleReconnect does not create unwanted tmux windows (hasActiveWindow guard)
3. SessionsView uses consistent IDs (both lists pass CLI UUID)
4. No more resolveSessionId translation failures
5. Fixes _registerCliUUID bug (references renamed column)
6. Eliminates ~200 lines of translation/mapping code
7. Push notifications navigate to correct session
8. Active session client count lookup simplified (no dual-ID check)

## Scope Boundaries

NOT included in this refactor:
- Changing tmux window names (they remain `{adapter}-{timestamp}` for display)
- Changing JSONL file paths (already CLI UUID based)
- Changing the Cross-AI Review feature (already uses CLI UUIDs)
- Auto N-round debate or other deferred features
