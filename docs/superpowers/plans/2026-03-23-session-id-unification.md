# Session ID Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify session ID management across all adapters — single storage (SQLite), adapter-prefixed internal IDs, CLI UUID in chat header, and real-time session discovery via API-based SessionStart hook.

**Architecture:** Bottom-up: DB schema migration → server adapter changes (Claude, Codex) → session-manager protocol update → client UI → CLI script → E2E spec updates. Each task produces a committable, non-breaking state.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), React, Bash (CLI), Gherkin (E2E specs)

**Spec:** `docs/superpowers/specs/2026-03-23-session-id-unification-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/db.ts` | Modify | Schema migration, rename columns, add `clearAll()`, remove session-map migration |
| `server/config.ts` | Modify | Remove `sessionMap` path |
| `server/index.ts` | Modify | Call `clearAll()` on shutdown |
| `server/adapters/interface.ts` | Modify | Add `adapter`, rename `claudeSessionId` → `cliSessionId` in `ActiveSessionInfo` |
| `server/adapters/claude/hook-config.ts` | Modify | SessionStart → `fireAndForget` |
| `server/adapters/claude/index.ts` | Modify | Add `session-start` hook route |
| `server/adapters/claude/tmux-adapter.ts` | Modify | `claude-` prefix, remove `desktop-`, add `handleSessionStart`, update `resolveSessionId` recovery |
| `server/adapters/codex/codex-tmux-adapter.ts` | Modify | `codex-` prefix, remove `desktop-`, align with Claude pattern |
| `server/adapters/codex/index.ts` | Verify | Ensure `session-start` hook route exists |
| `server/session-manager.ts` | Modify | `SESSION_CREATED` includes `cliSessionId` |
| `src/hooks/useChat.ts` | Modify | Store `cliSessionId` from `SESSION_CREATED` |
| `src/components/ChatView.tsx` | Modify | Header shows CLI UUID (primary) + internal ID (secondary) |
| `bin/codetap` | Modify | `--adapter` flag, window naming, resume/continue logic, `-a`/`-A` display |
| `bin/codetap-hook` | Delete | Replaced by API POST |
| `tests/e2e-spec.feature` | Modify | 9 scenario updates for new session ID architecture |

---

### Task 1: DB Schema Migration

**Files:**
- Modify: `server/db.ts:19-29` (CREATE TABLE), `server/db.ts:105-130` (prepared statements), `server/db.ts:252-287` (operations)

- [ ] **Step 1: Update CREATE TABLE for fresh installs (line 19-29)**

Change `claude_session` → `cli_session`, add `adapter`, remove `is_active`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cli_session TEXT NOT NULL,
  adapter TEXT DEFAULT 'claude',
  cwd TEXT NOT NULL,
  window_id TEXT,
  permission_mode TEXT DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  last_activity TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli_session);
CREATE INDEX IF NOT EXISTS idx_sessions_adapter ON sessions(adapter);
```

- [ ] **Step 2: Add migration logic after CREATE TABLE block**

After line 59, add migration for existing databases:

```typescript
try {
  const tableInfo = d.prepare("PRAGMA table_info('sessions')").all() as { name: string }[];
  const hasOldColumn = tableInfo.some(c => c.name === 'claude_session');
  const hasNewColumn = tableInfo.some(c => c.name === 'cli_session');
  const hasAdapter = tableInfo.some(c => c.name === 'adapter');

  if (hasOldColumn && !hasNewColumn) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN claude_session TO cli_session`);
    console.log('[db] Migrated: claude_session → cli_session');
  }
  if (!hasAdapter) {
    d.exec(`ALTER TABLE sessions ADD COLUMN adapter TEXT DEFAULT 'claude'`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_adapter ON sessions(adapter)`);
    console.log('[db] Migrated: added adapter column');
  }
} catch (e) {
  console.warn('[db] Migration check:', (e as Error).message);
}
```

- [ ] **Step 3: Update `SessionRow` interface (line 252-261)**

```typescript
export interface SessionRow {
  id: string;
  cli_session: string;
  adapter: string;
  cwd: string;
  window_id: string | null;
  permission_mode: string;
  created_at: string;
  last_activity: string;
}
```

- [ ] **Step 4: Update prepared statements (lines 105-130)**

All SQL: `claude_session` → `cli_session`, remove `is_active` references. Add `adapter` to upsert. Rename `sessionsFindByClaudeSession` → `sessionsFindByCliSession`. Change `sessionsRemove` from `UPDATE SET is_active=0` to `DELETE`. Remove `sessionsCleanupStale`.

- [ ] **Step 5: Update `sessions` operations object (line 263-287)**

```typescript
export const sessions = {
  upsert(id: string, cliSession: string, cwd: string, windowId?: string, adapter?: string): void {
    stmts().sessionsUpsert.run(id, cliSession, cwd, windowId ?? null, adapter ?? 'claude');
  },
  findByCliSession(cliSession: string): SessionRow | undefined {
    return stmts().sessionsFindByCliSession.get(cliSession) as SessionRow | undefined;
  },
  findByWindowId(windowId: string): SessionRow | undefined {
    return stmts().sessionsFindByWindowId.get(windowId) as SessionRow | undefined;
  },
  remove(id: string): void { stmts().sessionsRemove.run(id); },
  getAll(): SessionRow[] { return stmts().sessionsGetAll.all() as SessionRow[]; },
  clearAll(): void { getDB().exec('DELETE FROM sessions'); },
};
```

- [ ] **Step 6: Remove session-map.json migration (lines 196-219)**

Delete the session-map section of `migrateJsonToSqlite`. Keep the push-subscriptions migration. Remove `SessionMapJsonEntry` interface.

- [ ] **Step 7: Commit**

```bash
git add server/db.ts
git commit -m "refactor: migrate session DB schema — cli_session, adapter column, remove is_active"
```

---

### Task 2: Remove `sessionMap` from config + add `clearAll()` to shutdown

**Files:**
- Modify: `server/config.ts:18,58`
- Modify: `server/index.ts:245-253`

- [ ] **Step 1: Remove `sessionMap` from config**

In `AppConfig.paths` (line 18), remove `sessionMap: string;`.
In `loadConfig()` (line 58), remove `sessionMap: path.join(CODETAP_DIR, 'session-map.json'),`.

- [ ] **Step 2: Add `sessions.clearAll()` to shutdown**

In `shutdown()` (line 245-253), before `closeDB()`:

```typescript
import { sessions as dbSessions } from './db.js';
// ...
dbSessions.clearAll();
closeDB();
```

- [ ] **Step 3: Commit**

```bash
git add server/config.ts server/index.ts
git commit -m "refactor: remove sessionMap config, clear sessions on shutdown"
```

---

### Task 3: Update `ActiveSessionInfo` — rename `claudeSessionId` → `cliSessionId`

**Files:**
- Modify: `server/adapters/interface.ts:18-28`
- Modify: all files referencing `claudeSessionId`

- [ ] **Step 1: Update interface**

In `ActiveSessionInfo` (line 18-28), rename `claudeSessionId` → `cliSessionId`, add `adapter`:

```typescript
export interface ActiveSessionInfo {
  sessionId: string;
  cwd: string;
  cliSessionId: string;
  adapter: string;
  permissionMode: string;
  lastActivity: number | null;
  hasClients: boolean;
  hasDesktop: boolean;
  isNonInteractive: boolean;
  firstPrompt: string | null;
}
```

- [ ] **Step 2: Find and fix all `claudeSessionId` references**

```bash
grep -rn 'claudeSessionId' server/ src/ --include='*.ts' --include='*.tsx'
```

Replace `claudeSessionId` → `cliSessionId` in ALL files:
- `server/index.ts` (active-sessions endpoint)
- `server/session-manager.ts` (push notifications, pending sessions)
- `server/adapters/claude/tmux-adapter.ts` (`SessionState` interface field, `getActiveSessions`, `_createSession`, all usages)
- `server/adapters/codex/codex-tmux-adapter.ts` (same: `SessionState` field → rename to `cliSessionId`)
- `src/hooks/useSessions.ts` (activeSessionIds set)
- `src/components/SessionsView.tsx` (pending badge)

Note: The `SessionState` interfaces in both adapter files have a `claudeSessionId` / `codexSessionId` field that stores the CLI UUID. Rename both to `cliSessionId` for consistency across adapters.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: rename claudeSessionId → cliSessionId across codebase"
```

---

### Task 4: Claude adapter — SessionStart hook + internal ID format

**Files:**
- Modify: `server/adapters/claude/hook-config.ts:174,197`
- Modify: `server/adapters/claude/index.ts:113-147`
- Modify: `server/adapters/claude/tmux-adapter.ts:130,858`

- [ ] **Step 1: SessionStart hook → `fireAndForget` (hook-config.ts)**

Line 197: change `hookPath` to `fireAndForget('session-start')`.
Remove `hookPath` from `_hookIdentifiers()` (line 174). Update `_isOurHookEntry` to only check `portTag`.

- [ ] **Step 2: Add `session-start` route (index.ts)**

After line 147, add:
```typescript
hookRoute(`${prefix}/session-start`, (body) => {
  this._tmux.handleSessionStart(body);
});
```

- [ ] **Step 3: Add `handleSessionStart` method (tmux-adapter.ts)**

New method. Algorithm:

```typescript
async handleSessionStart(body: HookBody): Promise<void> {
  const cliUuid = body.session_id;
  if (!cliUuid) return;

  // 1. Already known? (idempotent — safe if hook fires twice)
  const cached = this.claudeToSessionId.get(cliUuid);
  if (cached && this.sessions.has(cached)) {
    this.sessions.get(cached)!.lastActivity = Date.now();
    return;
  }

  const windows = await tmuxManager.listWindows();
  const cwd = body.cwd || process.cwd();

  // 2. Recovery: check DB for original internal ID (non-graceful restart)
  const dbRow = dbSessions.findByCliSession(cliUuid);
  if (dbRow?.window_id && windows.some(w => w.id === dbRow.window_id)) {
    const sessionId = dbRow.id;  // Restore ORIGINAL internal ID
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, this._createSession(dbRow.window_id, cwd, cliUuid, dbRow.permission_mode || 'default'));
      this._startMonitor(sessionId, dbRow.window_id);
      this._ensureWatcher(sessionId);
    }
    this.claudeToSessionId.set(cliUuid, sessionId);
    return;
  }

  // 3. New session: find unmanaged tmux window with claude- prefix
  //    The hook body doesn't contain the window name, but the tmux window
  //    was created by bin/codetap with name "claude-{timestamp}".
  //    We find the first claude-* window that isn't already managed.
  for (const w of windows) {
    if (w.name.startsWith('claude-') && !this.sessions.has(w.name)) {
      const alreadyManaged = [...this.sessions.values()].some(s => s.windowId === w.id);
      if (!alreadyManaged) {
        const sessionId = w.name;
        this.sessions.set(sessionId, this._createSession(w.id, cwd, cliUuid, 'default'));
        this.claudeToSessionId.set(cliUuid, sessionId);
        dbSessions.upsert(sessionId, cliUuid, cwd, w.id, 'claude');
        this._startMonitor(sessionId, w.id);
        this._ensureWatcher(sessionId);
        this.emit('session-discovered', sessionId);
        return;
      }
    }
  }
}
```

- [ ] **Step 4: Change `startSession` ID format (tmux-adapter.ts:130)**

```typescript
const windowName = `claude-${Date.now()}`;
```

Update `dbSessions.upsert` to pass `'claude'` as adapter.

- [ ] **Step 5: Update `resolveSessionId` — remove `desktop-` prefix entirely (tmux-adapter.ts:858)**

The `desktop-` prefix logic is no longer needed. Change line 858 from:
```typescript
const sessionId = `desktop-${claudeSessionId.slice(0, 8)}`;
```
to:
```typescript
const sessionId = dbRow.id;  // Restore original internal ID from DB (e.g., claude-1774210269126)
```

The DB row's `id` field will now always be in `{adapter}-{timestamp}` format. No new ID is generated — we reuse what was stored.

- [ ] **Step 6: Rename `findByClaudeSession` → `findByCliSession` in all calls**

- [ ] **Step 7: Update `getActiveSessions` — add `adapter: 'claude'`, rename field**

- [ ] **Step 8: Commit**

```bash
git add server/adapters/claude/
git commit -m "feat: Claude adapter — session-start API hook, claude- prefix, remove desktop-"
```

---

### Task 5: Codex adapter — align with unified schema

**Files:**
- Modify: `server/adapters/codex/codex-tmux-adapter.ts:121,242`
- Modify: `server/adapters/codex/index.ts`

- [ ] **Step 1: Change `startSession` ID to `codex-` prefix (line 121)**

- [ ] **Step 2: Remove `desktop-` in `handleSessionStart` (line 242) — use DB original ID**

- [ ] **Step 3: Update `getActiveSessions` — add `adapter: 'codex'`, rename field**

- [ ] **Step 4: Rename `findByClaudeSession` → `findByCliSession` in all calls**

- [ ] **Step 5: Commit**

```bash
git add server/adapters/codex/
git commit -m "feat: Codex adapter — codex- prefix, remove desktop-, align with unified schema"
```

---

### Task 6: `SESSION_CREATED` includes `cliSessionId`

**Files:**
- Modify: `server/session-manager.ts:198,266`

- [ ] **Step 1: Update `handleQuery` SESSION_CREATED (line 198)**

```typescript
// After Task 3 rename, SessionState.claudeSessionId → cliSessionId
const sessionObj = adapter.getSession(handle.sessionId) as { cliSessionId?: string } | null;
send(conn, {
  type: WS.SESSION_CREATED,
  sessionId: handle.sessionId,
  cliSessionId: sessionObj?.cliSessionId || handle.sessionId,
});
```

- [ ] **Step 2: Update `handleReconnect` SESSION_CREATED (line 266)**

Same pattern — cast `getSession()` result and read `cliSessionId`.

- [ ] **Step 3: Commit**

```bash
git add server/session-manager.ts
git commit -m "feat: SESSION_CREATED includes cliSessionId for chat header"
```

---

### Task 7: Client — store `cliSessionId` + update chat header

**Files:**
- Modify: `src/hooks/useChat.ts:95,143`
- Modify: `src/components/ChatView.tsx:54-88,230`

- [ ] **Step 1: Add `cliSessionId` state in useChat (line 95)**

```typescript
const [cliSessionId, setCliSessionId] = useState<string | null>(null);
```

Update SESSION_CREATED handler (line 143):
```typescript
case WS.SESSION_CREATED:
  setSessionId(msg.sessionId);
  if (msg.cliSessionId) setCliSessionId(msg.cliSessionId);
  break;
```

Add `cliSessionId` to the returned object.

- [ ] **Step 2: Update ChatHeader component (ChatView.tsx:54-88)**

Accept `cliSessionId` prop. Display CLI UUID as primary (truncated, with copy), internal ID as secondary line below.

- [ ] **Step 3: Update ChatHeader usage (ChatView.tsx:230)**

```tsx
<ChatHeader sessionId={sessionId || initialSessionId} cliSessionId={cliSessionId} cwd={cwd} />
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useChat.ts src/components/ChatView.tsx
git commit -m "feat: chat header shows CLI UUID (primary) + internal ID (secondary)"
```

---

### Task 8: CLI — `--adapter` flag + window naming + enhanced display

**Files:**
- Modify: `bin/codetap`
- Delete: `bin/codetap-hook`

- [ ] **Step 1: Add `--adapter` flag parsing**

Insert before the resume mode section (around line 304). This parses `--adapter` from anywhere in the args:

```bash
# --- Parse --adapter flag ---
ADAPTER="claude"
ADAPTER_CMD="claude"
prev_arg=""
for arg in "$@"; do
  if [ "$prev_arg" = "--adapter" ]; then
    case "$arg" in
      claude) ADAPTER="claude"; ADAPTER_CMD="claude" ;;
      codex)  ADAPTER="codex";  ADAPTER_CMD="codex" ;;
      *)      echo "Unknown adapter: $arg"; exit 1 ;;
    esac
  fi
  prev_arg="$arg"
done
# Strip --adapter and its value from positional args
CLEANED_ARGS=()
skip_next=false
for arg in "$@"; do
  if $skip_next; then skip_next=false; continue; fi
  if [ "$arg" = "--adapter" ]; then skip_next=true; continue; fi
  CLEANED_ARGS+=("$arg")
done
set -- "${CLEANED_ARGS[@]}"
```

- [ ] **Step 2: Update window naming and commands**

Replace the resume/continue/new block (lines 305-316):

```bash
if [ "$1" = "--resume" ] && [ -n "$2" ]; then
  WINDOW_NAME="$2"
  COMMAND="$ADAPTER_CMD $YOLO --resume $2"
  shift 2
elif [ "$1" = "--continue" ]; then
  WINDOW_NAME="${ADAPTER}-$(date +%s)"
  case "$ADAPTER" in
    claude) COMMAND="$ADAPTER_CMD $YOLO --continue" ;;
    codex)  COMMAND="$ADAPTER_CMD resume --last" ;;
    *)      COMMAND="$ADAPTER_CMD --continue" ;;
  esac
  shift
else
  WINDOW_NAME="${ADAPTER}-$(date +%s)"
  COMMAND="$ADAPTER_CMD $YOLO $*"
fi
```

- [ ] **Step 3: Enhance `-a`/`-A` display**

Update the session listing loop to query the server API for UUID:

```bash
# Fetch session details from running server
SESSION_DATA=$(curl -sf $CURL_OPTS \
  "$PROTOCOL://127.0.0.1:$PORT/api/active-sessions" 2>/dev/null)

# In the listing loop, extract UUID per window name:
UUID=$(echo "$SESSION_DATA" | python3 -c "
import json, sys
try:
  for s in json.load(sys.stdin):
    if s.get('sessionId') == '$NAME':
      print(s.get('cliSessionId', '')); break
except: pass
" 2>/dev/null)

echo "  $i) $NAME"
[ -n "$UUID" ] && echo "     UUID: $UUID"
```

- [ ] **Step 4: Delete `bin/codetap-hook`**

- [ ] **Step 5: Commit**

```bash
git add bin/codetap
git rm bin/codetap-hook
git commit -m "feat: CLI — --adapter flag, adapter-prefixed windows, enhanced display"
```

---

### Task 9: Update E2E Specs

**Files:**
- Modify: `tests/e2e-spec.feature`

- [ ] **Step 1: Chat header display (L247)** — CLI UUID primary + internal ID secondary
- [ ] **Step 2: CLI `--adapter` scenarios (after L1238)** — `codetap new --adapter codex`
- [ ] **Step 3: `-a`/`-A` display format (L1212)** — UUID + internal ID
- [ ] **Step 4: Remove session-map.json refs (L1308)** — DB-based recovery
- [ ] **Step 5: Session Dedup regression (L1829)** — updated root cause
- [ ] **Step 6: SessionStart hook scenario** — API POST flow
- [ ] **Step 7: tmux window naming (L1176)** — `{adapter}-{timestamp}` format
- [ ] **Step 8: Non-graceful restart recovery (after L1325)** — restore from DB
- [ ] **Step 9: Active session card UUID (L1548)** — clarify display locations
- [ ] **Step 10: Commit**

```bash
git add tests/e2e-spec.feature
git commit -m "test: update E2E specs for session ID unification"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Build and start server**

```bash
npm run build && CLAUDE_UI_PASSWORD=test npx tsx server/index.ts
```

Verify: No migration errors in console.

- [ ] **Step 2: Web UI — new session**

Open CodeTap → New → send message.
Verify: Header shows CLI UUID (primary) + `claude-{timestamp}` (secondary).

- [ ] **Step 3: Active tab — no duplicates**

Verify: Only 1 session, no duplicates. Connect button works.

- [ ] **Step 4: CLI — codetap new**

Verify: tmux window named `claude-{timestamp}`, session appears immediately in Active tab.

- [ ] **Step 5: Server shutdown**

Verify: `codetap stop` clears sessions table and kills tmux windows.
