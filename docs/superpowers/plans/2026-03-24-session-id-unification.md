# Session ID Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dual session ID system (internal ID + CLI UUID) and unify on CLI UUID as the single source of truth across the entire codebase.

**Architecture:** 5 phases -- (1) DB schema migration, (2) adapter internals (both Claude + Codex), (3) session manager + permissions + push, (4) server endpoints + frontend, (5) CLI script + cleanup. Each phase builds on the previous.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), tmux, React, WebSocket, Shell (bin/codetap)

**Spec:** `docs/superpowers/specs/2026-03-24-session-id-unification-design.md`

---

## Phase 1: DB Schema

### Task 1: Migrate sessions table -- CLI UUID as primary key

**Files:**
- Modify: `server/db.ts`

- [ ] **Step 1: Update SessionRow interface (line 284)**

Remove `cli_session` field, add `window_name`:

```typescript
export interface SessionRow {
  id: string;              // CLI UUID (was internal ID)
  cwd: string;
  window_id: string | null;
  window_name: string | null;  // tmux window name for debug
  adapter: string;
  permission_mode: string;
  created_at: string;
  last_activity: string;
}
```

- [ ] **Step 2: Add schema migration in initDB() (after line 85)**

Detect old `cli_session` column and rebuild table:

```typescript
const hasCliSession = tableInfo.some((c: any) => c.name === 'cli_session');
const hasWindowName = tableInfo.some((c: any) => c.name === 'window_name');
if (hasCliSession && !hasWindowName) {
  d.exec(`
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
    INSERT OR IGNORE INTO sessions_new (id, cwd, window_id, window_name, adapter, permission_mode, created_at, last_activity)
    SELECT
      CASE WHEN cli_session IS NOT NULL AND cli_session != '' AND cli_session != id THEN cli_session ELSE id END,
      cwd, window_id, id, adapter, permission_mode, created_at, last_activity
    FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
    CREATE INDEX IF NOT EXISTS idx_sessions_window ON sessions(window_id);
  `);
  console.log('[db] Migrated sessions table: CLI UUID as primary key');
}
```

- [ ] **Step 3: Update CREATE TABLE for fresh installs (line 20)**

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  window_id TEXT,
  window_name TEXT,
  adapter TEXT DEFAULT 'claude',
  permission_mode TEXT DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  last_activity TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Update prepared statements**

Replace `sessionsUpsert` SQL:
```sql
INSERT INTO sessions (id, cwd, window_id, window_name, adapter)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  cwd = excluded.cwd,
  window_id = excluded.window_id,
  window_name = excluded.window_name,
  last_activity = datetime('now')
```

Replace `sessionsFindByCliSession` with `sessionsGet`:
```typescript
sessionsGet: d.prepare('SELECT * FROM sessions WHERE id = ?'),
```

- [ ] **Step 5: Update sessions operations export (line 308)**

```typescript
export const sessions = {
  upsert(id: string, cwd: string, windowId?: string, windowName?: string, adapter?: string): void {
    stmts().sessionsUpsert.run(id, cwd, windowId || null, windowName || null, adapter || 'claude');
  },
  get(id: string): SessionRow | undefined {
    return stmts().sessionsGet.get(id) as SessionRow | undefined;
  },
  findByWindowId(windowId: string): SessionRow | undefined {
    return stmts().sessionsFindByWindowId.get(windowId) as SessionRow | undefined;
  },
  remove(id: string): void { stmts().sessionsRemove.run(id); },
  getAll(): SessionRow[] { return stmts().sessionsGetAll.all() as SessionRow[]; },
  clearAll(): void { getDB().exec('DELETE FROM sessions'); },
};
```

Key: `upsert` signature changes from `(id, cliSession, cwd, windowId, adapter)` to `(id, cwd, windowId, windowName, adapter)`. `findByCliSession` replaced by `get` (PK lookup).

**IMPORTANT — Backward compatibility:** To allow each task to compile independently, KEEP the old methods as deprecated aliases alongside the new ones:

```typescript
/** @deprecated Use get() instead */
findByCliSession(cliSession: string): SessionRow | undefined {
  return this.get(cliSession);  // After migration, cli_session IS the id
},
/** @deprecated Use upsert(id, cwd, windowId, windowName, adapter) instead */
upsertLegacy(id: string, cliSession: string, cwd: string, windowId?: string, adapter?: string): void {
  // During transition: use cliSession as new id if it looks like a UUID, else use id
  const effectiveId = (cliSession && cliSession !== id && cliSession.includes('-')) ? cliSession : id;
  this.upsert(effectiveId, cwd, windowId, id, adapter);
},
```

These aliases are removed in Task 8 (cleanup). This allows Tasks 2-5 to compile at each intermediate step.

- [ ] **Step 6: Wrap migration in transaction**

Ensure the migration SQL in Step 2 is wrapped in a transaction:

```typescript
d.transaction(() => {
  d.exec(` ... migration SQL ... `);
})();
```

- [ ] **Step 7: Remove old index creation**

At lines 94-98 of db.ts, the `CREATE INDEX idx_sessions_cli ON sessions(cli_session)` must be removed or guarded (column no longer exists after migration).

- [ ] **Step 8: Commit**

```bash
git add server/db.ts
git commit -m "refactor: migrate sessions table -- CLI UUID as primary key"
```

---

## Phase 2: Adapter Internals

### Task 2: Unify Claude adapter to CLI UUID

**Files:**
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/claude/index.ts`
- Modify: `server/adapters/interface.ts`

- [ ] **Step 1: Remove translation infrastructure**

In `tmux-adapter.ts`:
- Remove `cliToSessionId: Map<string, string>` field (line 88)
- Remove ALL `this.cliToSessionId.set(...)` calls
- Remove `resolveSessionId()` method (lines 912-970)
- Remove `_registerCliUUID()` (lines 797-805) -- also fixes `claude_session` bug
- Remove `_remapCliSession()` (lines 779-785)
- Remove `_removeCliMapping()` (lines 792-793)

In `interface.ts`: remove `resolveSessionId` method from IAdapter base class.
In `claude/index.ts`: remove `resolveSessionId` delegation (line 219).

- [ ] **Step 2: Change sessions Map key to CLI UUID**

In `startSession()`:
- `const sessionId = cliSessionId` (was `windowName`)
- `this.sessions.set(sessionId, ...)` keyed by CLI UUID
- `dbSessions.upsert(sessionId, cwd, windowId, windowName, 'claude')` -- new signature
- Return `{ sessionId }` -- now CLI UUID

In `resumeSession()`:
- `const newSessionId = cliUuid` (was `'claude-${Date.now()}'`)
- Keep `const windowName = 'claude-${Date.now()}'` for tmux display
- `this.sessions.set(newSessionId, ...)` keyed by CLI UUID
- `dbSessions.upsert(newSessionId, cwd, windowId, windowName, 'claude')`
- Return `{ sessionId: newSessionId }`

In `attachSession()`: same pattern -- use CLI UUID as Map key.

In `handleSessionStart()`: use CLI UUID from hook body directly as Map key.

- [ ] **Step 3: Update _findWindowForSession (line 986)**

Replace window-name matching AND the `findByCliSession` fallback (line 994) with DB PK lookup:
```typescript
const dbRow = dbSessions.get(sessionId);
if (dbRow?.window_id) return dbRow.window_id;
```

Remove `windows.find(w => w.name === sessionId)` -- no longer matching by window name.

- [ ] **Step 4: Update all dbSessions.upsert calls to new signature**

Enumerate ALL call sites in this file and update each from `(id, cliSession, cwd, windowId, adapter)` to `(id, cwd, windowId, windowName, adapter)`:
- Line 136 (startSession)
- Line 192 (attachSession)
- Line 239 (resumeSession)
- Line 572 (handleSessionStart)
- Line 946 (inside resolveSessionId -- goes away when method is deleted)

- [ ] **Step 5: Commit**

```bash
git add server/adapters/claude/tmux-adapter.ts server/adapters/claude/index.ts server/adapters/interface.ts
git commit -m "refactor: Claude adapter uses CLI UUID as session key"
```

---

### Task 3: Unify Codex adapter to CLI UUID + _waitForCliUUID

**Files:**
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`
- Modify: `server/adapters/codex/index.ts`
- Modify: `server/adapters/codex/pane-monitor.ts`

- [ ] **Step 1: Remove translation infrastructure**

Same as Claude: remove `cliToSessionId` Map, `resolveSessionId()`, `_removeCliMapping()`.
In `codex/index.ts`: remove `resolveSessionId` delegation.

- [ ] **Step 2: Add _waitForCliUUID method**

New method that polls `session.cliSessionId` every 500ms (max 15s). When UUID discovered: re-key session in Map, upsert DB, remove temp key. On timeout: kill tmux window, remove temp session, throw error.

- [ ] **Step 3: Update startSession**

Store session under temp `windowName` key initially. After `_waitForReady`, call `await this._waitForCliUUID(windowName)` which returns CLI UUID. Return `{ sessionId: cliUUID }`.

- [ ] **Step 4: Update resumeSession + handleSessionStart + _watchForTranscript**

All use CLI UUID as Map key directly. `handleSessionStart` and `_watchForTranscript` set `session.cliSessionId` (which `_waitForCliUUID` polls for).

- [ ] **Step 5: Update all dbSessions.upsert calls to new signature**

Enumerate ALL call sites in this file:
- Line 135 (startSession)
- Line 189 (resumeSession)
- Line 337 (handleSessionStart)
- Line 753 (_watchForTranscript scanOnce lambda)
- Line 861 (_findAndAttachWindow)

- [ ] **Step 6: Commit**

```bash
git add server/adapters/codex/codex-tmux-adapter.ts server/adapters/codex/index.ts server/adapters/codex/pane-monitor.ts
git commit -m "refactor: Codex adapter uses CLI UUID, add _waitForCliUUID"
```

---

## Phase 3: Session Manager

### Task 4: Unify session-manager to CLI UUID

**Files:**
- Modify: `server/session-manager.ts`

- [ ] **Step 1: Remove all resolveSessionId calls**

In `handleQuery`: remove resolution block. `sessionId` from client is CLI UUID.
In `handleReconnect`: remove resolution block. Use `sessionId` directly as `effectiveId`.
Remove all `(adapter as ...).resolveSessionId?.(...)` casts.

- [ ] **Step 2: Simplify sendSessionCreated**

Send single `sessionId` (CLI UUID). Remove `cliSessionId` field.

- [ ] **Step 3: Simplify handleReconnect**

Preserve all 11 steps. Key changes:
- Step 6: add `hasActiveWindow` guard (prevent creating unwanted tmux windows)
- Step 8: use `sessionId` directly for `getMessages()` (CLI UUID = JSONL key)
- Step 11: use `sessionId` directly for `getActiveForParent()`
- Replace `dbSessions.findByCliSession` with `dbSessions.get`
- Remove dynamic `import('./db.js')` -- use static import

- [ ] **Step 4: Simplify triggerPush**

Single `getSession()` call. Use `sessionId` directly for child review check.

- [ ] **Step 5: Simplify session-ended handler**

`sessionId` IS CLI UUID. Remove convoluted DB lookup for `endedCliId`. Use directly for review cascade.

- [ ] **Step 6: Update dbSessions calls**

Replace all `dbSessions.findByCliSession(...)` with `dbSessions.get(...)`.

- [ ] **Step 7: Commit**

```bash
git add server/session-manager.ts
git commit -m "refactor: session-manager uses CLI UUID for broadcast and registration"
```

---

## Phase 4: Server Endpoints + Frontend

### Task 5: Update server/index.ts

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Replace dbSessions.findByCliSession with dbSessions.get**

All `dbSessions.findByCliSession(...)` calls become `dbSessions.get(...)`.

- [ ] **Step 2: Simplify active-sessions client count**

Replace `getClientCount(s.sessionId) || getClientCount(s.cliSessionId)` with `getClientCount(s.sessionId)`.

- [ ] **Step 3: Update review endpoints to use dbSessions.get**

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "refactor: server endpoints use CLI UUID, remove dual-ID lookups"
```

---

### Task 6: Unify frontend

**Files:**
- Modify: `src/hooks/useChat.ts`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/components/SessionsView.tsx`

- [ ] **Step 1: Merge sessionId + cliSessionId in useChat**

Remove `cliSessionId` state. Keep only `sessionId` (CLI UUID). Remove `setCliSessionId(msg.cliSessionId)` from SESSION_CREATED handler. Remove `cliSessionId` from return.

- [ ] **Step 2: Update ChatView**

Remove `cliSessionId` from useChat destructuring. Use `sessionId` for ChatHeader display and review API calls.

- [ ] **Step 3: Update useSessions**

Change `s.cliSessionId` to `s.sessionId` in `activeSessionIds` builder.

- [ ] **Step 4: Update SessionsView**

Change `pending[session.cliSessionId]` to `pending[session.sessionId]` for notification badges.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useChat.ts src/components/ChatView.tsx src/hooks/useSessions.ts src/components/SessionsView.tsx
git commit -m "refactor: frontend uses single sessionId (CLI UUID)"
```

---

## Phase 5: CLI + Cleanup

### Task 7: Update bin/codetap

**Files:**
- Modify: `bin/codetap`

- [ ] **Step 1: Update get_project_sessions() SQL (line 239)**

Change `SELECT id FROM sessions` to `SELECT window_name FROM sessions` -- returns tmux window names for matching.

- [ ] **Step 2: Update -a listing SQL (line 290)**

Change to `SELECT id, adapter, window_name, cwd FROM sessions WHERE window_name IN (...)`.

- [ ] **Step 3: Update --resume SQL (line 382)**

Change to `WHERE id='${SAFE_ID}' OR window_name='${SAFE_ID}'` -- accepts both CLI UUID and window name (backwards compatible for users who may pass old-style IDs).

- [ ] **Step 4: Commit**

```bash
git add bin/codetap
git commit -m "refactor: bin/codetap uses new DB schema"
```

---

### Task 8: Final cleanup -- remove deprecated aliases, verify all files

**Files:**
- Modify: `server/db.ts`
- Modify: `server/adapters/interface.ts`
- Modify: `tests/e2e-spec.feature`

- [ ] **Step 1: Remove deprecated DB method aliases**

In `server/db.ts`, remove `findByCliSession` and `upsertLegacy` deprecated aliases added in Task 1. Grep to verify zero remaining callers.

- [ ] **Step 2: Deprecate ActiveSessionInfo.cliSessionId**

In `server/adapters/interface.ts`, add `/** @deprecated Use sessionId instead */` comment.

- [ ] **Step 3: Verify no-op files from spec**

These files are listed in the spec as MODIFY but require no code changes (already use generic string params). Verify each with grep:
- `server/push.ts` -- callers now pass CLI UUID. NO CHANGE needed.
- `server/permission-manager.ts` -- callers now pass CLI UUID. NO CHANGE needed.
- `server/types/messages.ts` -- `QueryOptions.sessionId` is generic. NO CHANGE.
- `server/types/adapter.ts` -- `SessionInfo.sessionId` already CLI UUID. NO CHANGE.
- `src/lib/ws.ts`, `src/lib/api.ts`, `src/sw.ts`, `src/App.tsx`, `src/components/FloatingReviewPanel.tsx` -- NO CHANGE.

- [ ] **Step 4: Verify session_stats table**

Confirm `session_stats` table is never written to (no INSERT statements). No migration needed.

- [ ] **Step 5: Update e2e specs**

Remove references to dual-ID system, `resolveSessionId`, `cliSessionId` as separate concept.

- [ ] **Step 6: TypeScript compilation check**

`npx tsc --noEmit` -- zero errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: cleanup -- remove deprecated aliases, verify all files, update e2e specs"
```

---

## Verification

After all tasks:

1. Server starts, migration runs without errors
2. Open historical session from project list -- history loads immediately (no 30s wait)
3. Open session from active list -- connects correctly
4. Send message -- goes to correct tmux window
5. Desktop opens same session -- mobile receives streaming events in real-time
6. Push notification click -- navigates to correct session
7. Cross-AI Review -- create, chat, send-back, end -- all work
8. `bin/codetap -a` -- lists sessions correctly
9. `bin/codetap --resume <UUID>` -- resumes correctly
10. Server restart -- sessions re-discovered, reviews survive
