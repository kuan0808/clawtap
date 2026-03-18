# Window Name to CLI UUID + Backward Compat Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things: (1) Use CLI UUID as tmux window name, eliminating `window_name` column and all name-mapping. (2) Delete all backward-compat code (old migrations, deprecated aliases) since the app is pre-release.

**Architecture:** 5 tasks: (1) add renameWindow to TmuxManager, (2) update adapters to use CLI UUID as window name, (3) clean up DB — remove window_name + delete old migrations + simplify schema, (4) remove ActiveSessionInfo.cliSessionId from public API, (5) update bin/codetap.

**Tech Stack:** TypeScript, SQLite, tmux, Shell

**After this plan completes, the session ID system is fully clean:**
- Single ID everywhere: CLI UUID
- tmux window name = CLI UUID
- No translations, no mappings, no deprecated aliases
- DB has minimal schema with no migration chain

---

### Task 1: Add renameWindow to TmuxManager

**Files:**
- Modify: `server/adapters/claude/tmux-manager.ts`

- [ ] **Step 1: Add renameWindow method**

After `killWindow()`, add:

```typescript
async renameWindow(windowId: string, newName: string): Promise<void> {
  const target = `${SESSION_NAME}:${windowId}`;
  await exec(TMUX, ['rename-window', '-t', target, newName]);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/adapters/claude/tmux-manager.ts
git commit -m "feat: add renameWindow to TmuxManager"
```

---

### Task 2: Use CLI UUID as tmux window name in both adapters

**Files:**
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`

**Claude adapter:**

- [ ] **Step 1: startSession — use CLI UUID as window name**

Remove `const windowName = ...`. Pass `sessionId` (CLI UUID) directly:

```typescript
const windowId = await tmuxManager.createWindow(sessionId, cwd, parts.join(' '));
```

Update `dbSessions.upsert` — pass `undefined` for windowName (removed in Task 3):

```typescript
dbSessions.upsert(sessionId, cwd, windowId, undefined, 'claude');
```

- [ ] **Step 2: resumeSession — use CLI UUID as window name**

```typescript
const windowId = await tmuxManager.createWindow(cliUuid, cwd, command);
```

- [ ] **Step 3: attachSession — same pattern**

Remove windowName from upsert calls, pass `undefined`.

- [ ] **Step 4: Update _handleSessionStart discovery**

Replace `w.name.startsWith('claude-')` with:

```typescript
if (w.command.includes('claude') && !this.sessions.has(w.name)) {
```

This works because: CodeTap-created windows have CLI UUID names (which are in the sessions Map if managed). Desktop-started windows have arbitrary names (not in the Map). Either way, checking `!this.sessions.has(w.name)` correctly identifies unmanaged windows.

- [ ] **Step 5: Simplify _findWindowForSession**

```typescript
private async _findWindowForSession(sessionId: string, windowList?: TmuxWindow[]): Promise<string | null> {
  const windows = windowList || await tmuxManager.listWindows();
  // Primary: check DB for stored window_id
  const dbRow = dbSessions.get(sessionId);
  if (dbRow?.window_id && windows.some(w => w.id === dbRow.window_id)) {
    return dbRow.window_id;
  }
  // Fallback: match by name (window name = CLI UUID = sessionId)
  const match = windows.find(w => w.name === sessionId);
  return match?.id || null;
}
```

Note: `listWindows()` is called once and reused for both checks.

**Codex adapter:**

- [ ] **Step 6: startSession — temp name, then rename**

```typescript
const tempName = `codex-${Date.now()}`;
const windowId = await tmuxManager.createWindow(tempName, cwd, parts.join(' '));
// ... _waitForReady, _watchForTranscript ...
const cliUUID = await this._waitForCliUUID(tempName);
// Rename tmux window to CLI UUID
const session = this.sessions.get(cliUUID);
if (session?.windowId) {
  await tmuxManager.renameWindow(session.windowId, cliUUID);
}
return { sessionId: cliUUID };
```

- [ ] **Step 7: resumeSession — use CLI UUID as window name**

```typescript
const windowId = await tmuxManager.createWindow(codexUuid, cwd, parts.join(' '));
```

- [ ] **Step 8: Pass undefined for windowName in all upsert calls**

Both adapters: `dbSessions.upsert(id, cwd, windowId, undefined, adapter)`.

- [ ] **Step 9: Commit**

```bash
git add server/adapters/claude/tmux-adapter.ts server/adapters/codex/codex-tmux-adapter.ts
git commit -m "refactor: use CLI UUID as tmux window name"
```

---

### Task 3: Clean up DB — remove window_name, delete old migrations, simplify

**Files:**
- Modify: `server/db.ts`

This task does 3 things: (a) remove `window_name` column, (b) delete ALL old schema migrations, (c) delete `migrateJsonToSqlite`. Since the app is pre-release, no backward compat needed.

- [ ] **Step 1: Replace entire initDB() migration section with a single clean schema**

Delete ALL migration code in initDB():
- `claude_session → cli_session` rename (~line 83-85)
- `cli_session → id + window_name` table rebuild (~line 93-117)
- Any `PRAGMA table_info` checks

Replace the CREATE TABLE with the FINAL clean schema:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  window_id TEXT,
  adapter TEXT DEFAULT 'claude',
  permission_mode TEXT DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  last_activity TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_window ON sessions(window_id);
```

No `cli_session`, no `window_name`, no `claude_session`. Just the final schema.

- [ ] **Step 2: Delete migrateJsonToSqlite function**

Remove the entire `migrateJsonToSqlite` function (~line 282-309) and its exported types (`JsonPushSub`, etc.). Also remove its caller — grep for `migrateJsonToSqlite` in `server/index.ts`.

- [ ] **Step 3: Update SessionRow interface**

```typescript
export interface SessionRow {
  id: string;              // CLI UUID
  cwd: string;
  window_id: string | null;
  adapter: string;
  permission_mode: string;
  created_at: string;
  last_activity: string;
}
```

Remove `window_name` and `cli_session` fields entirely.

- [ ] **Step 4: Update upsert signature and SQL**

```typescript
upsert(id: string, cwd: string, windowId?: string, adapter?: string): void {
  stmts().sessionsUpsert.run(id, cwd, windowId || null, adapter || 'claude');
},
```

SQL:
```sql
INSERT INTO sessions (id, cwd, window_id, adapter)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  cwd = excluded.cwd,
  window_id = excluded.window_id,
  last_activity = datetime('now')
```

- [ ] **Step 5: Update ALL dbSessions.upsert callers**

Grep entire codebase. Change from 5-param to 4-param signature. Locations:
- `server/adapters/claude/tmux-adapter.ts` — all upsert calls (~4-5 sites)
- `server/adapters/codex/codex-tmux-adapter.ts` — all upsert calls (~4-5 sites)
- `server/adapters/codex/codex-tmux-adapter.ts` — `_waitForCliUUID` upsert

- [ ] **Step 6: Handle existing DB with old schema**

Since we deleted all migrations, if an old DB exists with `cli_session` or `window_name` columns, it will be incompatible. Add a simple destructive migration:

```typescript
// If old schema detected, just drop and recreate
const tableInfo = d.prepare("PRAGMA table_info('sessions')").all() as { name: string }[];
const hasOldColumns = tableInfo.some(c => c.name === 'cli_session' || c.name === 'window_name' || c.name === 'claude_session');
if (hasOldColumns) {
  d.exec('DROP TABLE sessions');
  // Table will be recreated by the CREATE TABLE IF NOT EXISTS above
  d.exec(`CREATE TABLE sessions (...final schema...)`);
  console.log('[db] Dropped old sessions table (pre-release cleanup)');
}
```

This is safe because the app is pre-release and `clearAll()` deletes all rows on shutdown anyway.

- [ ] **Step 7: Remove migrateJsonToSqlite caller from server/index.ts**

Grep for `migrateJsonToSqlite` in `server/index.ts` and remove the call.

- [ ] **Step 8: Commit**

```bash
git add server/db.ts server/index.ts server/adapters/claude/tmux-adapter.ts server/adapters/codex/codex-tmux-adapter.ts
git commit -m "refactor: clean DB schema — remove window_name, delete old migrations"
```

---

### Task 4: Remove ActiveSessionInfo.cliSessionId from public API

**Files:**
- Modify: `server/adapters/interface.ts`
- Modify: `server/adapters/claude/tmux-adapter.ts`
- Modify: `server/adapters/codex/codex-tmux-adapter.ts`
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/components/SessionsView.tsx`
- Modify: `server/index.ts`

- [ ] **Step 1: Remove cliSessionId from ActiveSessionInfo**

In `server/adapters/interface.ts`, remove:

```typescript
/** @deprecated Use sessionId instead — same value after unification */
cliSessionId: string;
```

- [ ] **Step 2: Remove cliSessionId from getActiveSessions in both adapters**

In Claude's `getActiveSessions()`: remove `cliSessionId: session.cliSessionId` from the returned object.
In Codex's `getActiveSessions()`: same.

- [ ] **Step 3: Update frontend useSessions.ts**

Change `if (s.cliSessionId) ids.add(s.cliSessionId)` to `if (s.sessionId) ids.add(s.sessionId)`. (May already be done — verify.)

- [ ] **Step 4: Update SessionsView.tsx**

Remove any remaining `session.cliSessionId` references. Use `session.sessionId` everywhere.

- [ ] **Step 5: Update server/index.ts active-sessions endpoint**

The active-sessions handler may still reference `s.cliSessionId` for child filtering. Change to `s.sessionId`.

- [ ] **Step 6: TypeScript compilation check**

`npx tsc --noEmit` — zero errors.

- [ ] **Step 7: Commit**

```bash
git add server/adapters/interface.ts server/adapters/claude/tmux-adapter.ts server/adapters/codex/codex-tmux-adapter.ts src/hooks/useSessions.ts src/components/SessionsView.tsx server/index.ts
git commit -m "refactor: remove deprecated cliSessionId from public API"
```

---

### Task 5: Update bin/codetap

**Files:**
- Modify: `bin/codetap`

- [ ] **Step 1: get_project_sessions() — query id**

```bash
# Before: SELECT window_name FROM sessions WHERE cwd=...
# After: SELECT id FROM sessions WHERE cwd=...
```

tmux window names are now CLI UUIDs = DB `id`.

- [ ] **Step 2: -a listing — match by id**

```bash
# Before: SELECT id, adapter, window_name, cwd FROM sessions WHERE window_name IN (...)
# After: SELECT id, adapter, cwd FROM sessions WHERE id IN (...)
```

- [ ] **Step 3: --resume — simplified**

```bash
# Before: WHERE id='...' OR window_name='...'
# After: WHERE id='...'
```

- [ ] **Step 4: Window name generation for new/continue**

Generate UUID for Claude (use `--session-id` value):

```bash
SESSION_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
WINDOW_NAME="$SESSION_UUID"
# For Claude: pass --session-id $SESSION_UUID
```

For Codex: use temp name, server will rename after UUID discovery.

- [ ] **Step 5: Remove any window_name references**

Grep entire script for `window_name` — should be zero after above changes.

- [ ] **Step 6: Commit**

```bash
git add bin/codetap
git commit -m "refactor: bin/codetap uses CLI UUID as tmux window name"
```

---

## Self-Review Checklist

### Compilation Safety
- Task 2 passes `undefined` for windowName param → Task 3 removes the param. Between Tasks 2 and 3, the code compiles because `undefined` is valid for an optional `string?` param. ✅
- Task 4 removes `cliSessionId` from `ActiveSessionInfo`. All consumers updated in same task. ✅

### Codex _waitForCliUUID Flow
- Session starts under temp name `codex-{timestamp}` → stored in Map under temp key
- Hook/watcher sets `session.cliSessionId` → `_waitForCliUUID` polls and detects it
- `_waitForCliUUID` re-keys Map: delete temp key, set CLI UUID key
- **NEW**: `renameWindow(windowId, cliUUID)` renames the tmux window
- After this: window name = Map key = DB id = CLI UUID ✅
- `session.cliSessionId` field kept in `CodexSessionState` (needed for _waitForCliUUID polling). Not exposed publicly. ✅

### handleReconnect
- User clicks session → `registerClient(conn, sessionId)` where sessionId = CLI UUID
- `hasActiveWindow(sessionId)` checks if tmux window exists for this session
- After window name change: `_findWindowForSession(sessionId)` finds by `w.name === sessionId` (window name = CLI UUID) ✅
- Desktop later opens same session → events broadcast to CLI UUID → mobile receives ✅

### DB Schema Final State
```sql
sessions: id(PK/UUID), cwd, window_id(@N), adapter, permission_mode, created_at, last_activity
session_reviews: id, parent_cli_session_id, child_cli_session_id, child_adapter, ...
```
No `cli_session`, no `window_name`, no `claude_session`. Clean. ✅

### Old DB Handling
- If old DB exists with legacy columns → DROP TABLE + recreate. Data loss is fine (pre-release). ✅
- `session_reviews` table is not touched — it was created with the correct schema. ✅

### bin/codetap
- `-a` mode: tmux window names are now UUIDs, DB `id` is UUID → direct IN clause match ✅
- `--resume`: accepts UUID → `WHERE id='...'` ✅
- `new` mode: generates UUID as window name ✅
- `--continue`: queries most recent session by `id` → resume it ✅

### Things NOT changed (correct to leave alone)
- `SessionState.cliSessionId` in both adapters — needed internally for Codex UUID discovery. Not exposed publicly after Task 4. ✅
- `session_reviews` table column names (`parent_cli_session_id`, `child_cli_session_id`) — these are just column names, not related to the internal ID concept. They store CLI UUIDs. ✅
- `tmux-manager.ts` `TmuxWindow.name` field — still populated from `#{window_name}` tmux format. Now contains CLI UUID. ✅

### Potential Issues
- **UUID as tmux tab name is long (36 chars)** — cosmetic only, tmux truncates display. Not a functional issue.
- **Desktop-started sessions (not via CodeTap)** — their tmux window name won't be a UUID. But `handleSessionStart` uses `w.command.includes('claude')` for discovery, not window name format. Hook body provides the CLI UUID. ✅
- **`python3 -c 'import uuid; print(uuid.uuid4())'` in bin/codetap** — requires Python 3. Could use `uuidgen` instead (available on macOS). Safer: `uuidgen | tr '[:upper:]' '[:lower:]'`

---

## Verification

1. Delete `~/.codetap/codetap.db` to start fresh (or let migration drop old table)
2. `CLAUDE_UI_PASSWORD=test npm run dev` — server starts cleanly
3. `tmux list-windows -t codetap` — windows named with CLI UUIDs
4. Click historical session → history loads immediately
5. New Claude session → window named with UUID, messages work
6. New Codex session → starts with temp name, renamed to UUID
7. `bin/codetap -a` → lists sessions
8. `bin/codetap --resume <UUID>` → works
9. Active sessions tab → shows sessions, no `cliSessionId` references
10. `grep -rn "window_name\|cli_session\|cliSessionId\|claude_session" server/ src/` → zero results (except internal `SessionState.cliSessionId` in adapters)
