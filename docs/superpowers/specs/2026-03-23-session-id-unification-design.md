# Session ID Unification Design Spec

## Problem

CodeTap's session management has grown organically and now has several issues:

1. **Dual ID system** — Each session has an "internal ID" (`session-{timestamp}` or `desktop-{uuid前8字}`) and a "CLI UUID". The internal ID is meaningless to users but is what the UI displays.
2. **Dual storage** — `session-map.json` (file) and SQLite (DB) both store session mappings. The file is written by the SessionStart hook but only read on server startup, causing `codetap new` sessions to not appear in Active Sessions until server restart.
3. **`desktop-` prefix confusion** — Sessions that are "rediscovered" after a non-graceful server restart get a new `desktop-` internal ID, losing their original ID.
4. **No adapter awareness in IDs** — Internal IDs don't indicate which adapter (Claude/Codex/Gemini) the session belongs to.
5. **User can't resume from desktop** — The chat header shows the internal ID which can't be used with `claude --resume`.

## Design Decisions

| Topic | Decision |
|-------|----------|
| Scope | All adapters (Claude, Codex, future) |
| Storage | SQLite only — remove session-map.json |
| SessionStart hook | POST to server API (like all other hooks) |
| Internal ID format | `{adapter}-{timestamp}` (e.g., `claude-1774210269126`) |
| `desktop-` prefix | Removed entirely |
| Non-graceful restart recovery | Read original internal ID from DB |
| User-facing display | Chat header: CLI UUID (primary) + internal ID (secondary) |
| Active Sessions list | Keep showing `firstPrompt` (no change) |
| DB on shutdown | Clear `sessions` table (tmux windows are killed, records are useless) |
| CLI `--adapter` flag | Added to `codetap new` and `codetap --continue` |
| CLI `--resume` | Accepts internal ID or CLI UUID; scans JSONL dirs to detect adapter |
| CLI `--continue` | Pass through to adapter CLI's native continue command |
| Adapter selector UI | Not in scope (future work) |

## Architecture

### Internal ID Format

```
{adapter}-{timestamp}

Examples:
  claude-1774210269126
  codex-1774210345678
  gemini-1774210500000
```

Produced by:
- `startSession()` in each adapter (Web UI new session)
- `bin/codetap` CLI script (`codetap new`, `codetap --resume`, `codetap --continue`)

### Single Source of Truth: SQLite

All session mappings go through SQLite. No file-based storage.

**SessionStart hook flow (unified for all entry points):**

```
Claude/Codex CLI starts → SessionStart hook fires
    ↓
POST /api/hooks/{adapter}/session-start
body: { session_id: "<CLI UUID>", cwd: "/path", ... }
    ↓
Server handler:
  1. Find tmux window for this session (by window name or DB lookup)
  2. If session already in memory → update mapping (e.g., /resume changed UUID)
  3. If session NOT in memory → create new entry:
     - Internal ID from tmux window name (e.g., claude-1774210269126)
     - Map CLI UUID → internal ID
     - Write to DB
  4. Session appears in Active Sessions immediately
```

**Shutdown flow:**

```
SIGTERM/SIGINT received
    ↓
1. adapter.destroy() → tmuxManager.killSession() → all tmux windows killed
2. dbSessions.clearAll() → clear sessions table
3. closeDB()
```

### DB Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,        -- internal ID (claude-1774210269126)
  cli_session TEXT,           -- CLI native UUID
  adapter TEXT,               -- 'claude' / 'codex' / 'gemini'
  cwd TEXT,
  window_id TEXT,
  permission_mode TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  last_activity DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_cli ON sessions(cli_session);
CREATE INDEX idx_sessions_adapter ON sessions(adapter);
```

Migration: rename `claude_session` → `cli_session`, add `adapter` column (default `'claude'` for existing rows), remove `is_active` column.

### Chat Header Display

```
┌──────────────────────────────────────────────────┐
│ ← code-tap  625c60d0-aedb-4e0b...  [copy icon] │
│             claude-1774210269126                 │
└──────────────────────────────────────────────────┘
```

- Primary: CLI UUID (truncated), click copy icon to copy full UUID → usable with `claude --resume <uuid>`
- Secondary: internal ID → usable with `tmux select-window -t codetap:claude-1774210269126`

`SESSION_CREATED` message updated to include both `sessionId` (internal) and `cliSessionId` (UUID).

### Hook Config Change

In `hook-config.ts`, SessionStart changes from file-writing script to `fireAndForget` API POST (same pattern as all other hooks):

```typescript
// Before:
SessionStart: [{ hooks: [{ type: 'command', command: hookPath, timeout: 2 }] }]

// After:
SessionStart: [{ hooks: [{ type: 'command', command: fireAndForget('session-start'), timeout: 2 }] }]
```

### SESSION_CREATED Message Payload

```typescript
// Before:
{ type: 'session-created', sessionId: string }

// After:
{ type: 'session-created', sessionId: string, cliSessionId: string }
```

`useChat` hook stores both IDs. `ChatView` header displays `cliSessionId` (primary) and `sessionId` (secondary).

### Recovery from Non-Graceful Shutdown

If the server crashes (kill -9, power loss) without running the shutdown flow:

1. Tmux session `codetap` may still be alive with running CLI instances
2. On next server start, DB still has session records (SQLite persists)
3. When hooks fire from surviving CLI instances → `resolveSessionId`:
   - Finds the session in DB by `cli_session` UUID
   - Restores the **original** internal ID from DB (e.g., `claude-1774210269126`)
   - Re-creates in-memory mapping
   - Session reappears in Active Sessions with its original ID

If the CLI session hasn't fired a SessionStart hook yet (e.g., Codex before first interaction):
- Session stays in DB with `cli_session = NULL`
- Once hook fires → DB record updated with CLI UUID
- UI shows UUID after hook fires (brief grace period showing internal ID only)

### CLI Changes (`bin/codetap`)

**`codetap new [--adapter <name>]`**

```bash
codetap new                    # WINDOW_NAME="claude-$(date +%s)", runs: claude
codetap new --adapter codex    # WINDOW_NAME="codex-$(date +%s)", runs: codex
codetap new --adapter gemini   # WINDOW_NAME="gemini-$(date +%s)", runs: gemini
```

Default adapter: `claude`. The `--adapter` flag determines both the window name prefix and the CLI command to run.

**`codetap --resume <id>`**

```
Input: internal ID or CLI UUID
    ↓
Is it internal ID format? ({adapter}-{digits})
├─ Yes → extract adapter from prefix, query DB for CLI UUID
│   ├─ Found → run: {adapter} --resume {uuid}
│   └─ Not found → error
└─ No (UUID format) → query DB by cli_session
    ├─ Found → get adapter from DB → run: {adapter} --resume {uuid}
    └─ Not found → scan JSONL directories per adapter
        ├─ Found → detected adapter → run: {adapter} --resume {uuid}
        └─ Not found → error: "Session not found"
```

**`codetap --continue [--adapter <name>]`**

Pass through to adapter CLI's native continue command:
- `claude --continue`
- `codex resume --last`

Window name: `{adapter}-{timestamp}` (same format as `new`).

SessionStart hook handles the mapping automatically when the CLI starts — even if the continued session was never managed by CodeTap before.

Default adapter: `claude`. With `--adapter codex`, runs codex's native continue command instead.

**`codetap -a / -A`**

Enhanced display:

```
Active sessions for code-tap:

  1) claude-1774210269126
     UUID: 625c60d0-aedb-4e0b-b78e-c9fbf0405e67
     reply pong...

  2) codex-1774210345678
     UUID: abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx
     fix the login bug...

Select (1-2):
```

### Files to Modify

**Server:**
- `server/db.ts` — Schema migration, rename column, add `adapter` field, add `clearAll()`, remove session-map.json migration
- `server/adapters/claude/tmux-adapter.ts` — Remove `desktop-` logic from `resolveSessionId`, change `session-` to `claude-` in `startSession`, add `session-start` handler, restore original ID on recovery
- `server/adapters/claude/hook-config.ts` — Change SessionStart from `hookPath` script to `fireAndForget('session-start')`
- `server/adapters/claude/index.ts` — Add `session-start` hook route
- `server/adapters/codex/codex-tmux-adapter.ts` — Same pattern: `codex-` prefix, unified session-start handling
- `server/adapters/codex/index.ts` — Add `session-start` hook route if missing
- `server/adapters/interface.ts` — Add `adapter` field to `ActiveSessionInfo`
- `server/session-manager.ts` — Pass `cliSessionId` in `SESSION_CREATED` message
- `server/index.ts` — Call `dbSessions.clearAll()` in shutdown
- `server/config.ts` — Remove `sessionMap` path config

**Client:**
- `src/hooks/useChat.ts` — Store `cliSessionId` from `SESSION_CREATED`
- `src/components/ChatView.tsx` — Header shows CLI UUID (primary) + internal ID (secondary)
- `src/components/SessionsView.tsx` — No change (already shows `firstPrompt`)

**CLI:**
- `bin/codetap` — Add `--adapter` flag, change window naming, update resume/continue logic, enhance `-a`/`-A` display
- `bin/codetap-hook` — Delete (replaced by API POST)

### E2E Spec Updates (`tests/e2e-spec.feature`)

The following scenarios need to be updated to reflect the new session ID architecture:

1. **Chat header display** (L247): Update to show CLI UUID (primary) + internal ID (secondary) with copy icon
2. **CLI `--adapter` flag** (L1168-1475): Add scenarios for `codetap new --adapter`, `codetap --continue --adapter`
3. **Active sessions `-a`/`-A` display** (L1212): Update to show UUID + internal ID format
4. **session-map.json references** (L1308): Remove; update to DB-based recovery
5. **Session Deduplication regression** (L1829): Update to reflect Connect button fix (claudeSessionId → sessionId)
6. **SessionStart hook**: Add scenario documenting API POST flow (replaces file-writing script)
7. **tmux window naming** (L1176): Specify `{adapter}-{timestamp}` format
8. **Non-graceful restart recovery** (L1308): Add scenario for restoring original ID from DB
9. **Active session card UUID field** (L1548): Clarify where UUIDs appear (title vs expanded view)

### What Gets Removed

- `bin/codetap-hook` script
- `session-map.json` mechanism (writing, reading, migration)
- `desktop-` prefix logic in `resolveSessionId`
- `is_active` column from sessions table
- `sessionMap` path in config
