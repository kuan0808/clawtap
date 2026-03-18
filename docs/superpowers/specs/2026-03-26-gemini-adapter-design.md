# Gemini CLI Adapter Design

**Date:** 2026-03-26
**Status:** Draft
**Approach:** B — Shared layer extraction + Gemini adapter

## Overview

Add a third adapter to code-tap for Google's Gemini CLI (v0.34.0+), providing full bidirectional control from the mobile PWA — identical feature parity with the existing Claude and Codex adapters.

## Scope

- Full Gemini adapter: tmux session management, prompt sending, streaming, tool tracking, permission approval, thinking display, model/permission mode switching
- New `JsonWatcher` for Gemini's single-JSON session format
- Bridge script for Gemini's stdin/stdout hook protocol
- Shared layer: move `tmux-manager.ts` to `server/adapters/shared/`
- CLI, registry, and frontend integration

## Research Findings

### Gemini CLI Architecture

| Aspect | Detail |
|---|---|
| **Version** | 0.34.0 |
| **Config dir** | `~/.gemini/` |
| **Settings** | `~/.gemini/settings.json` |
| **Session files** | `~/.gemini/tmp/<project-name>/chats/session-*.json` (single JSON, not JSONL) |
| **Project mapping** | `~/.gemini/projects.json` maps abs paths to project names |
| **Project root** | `~/.gemini/tmp/<project-name>/.project_root` contains abs path |
| **Hook protocol** | stdin/stdout JSON (not HTTP like Claude) |
| **Hook events** | BeforeTool, AfterTool, BeforeAgent, AfterAgent, SessionStart, SessionEnd, + more |
| **Models** | auto, pro (2.5 Pro), flash (2.5 Flash), flash-lite |
| **Permission modes** | default, auto_edit, yolo, plan |
| **Resume** | `gemini --resume <id-or-index>` |
| **GEMINI.md** | Yes, analogous to CLAUDE.md |

### Session File Format (JSON, not JSONL)

```json
{
  "sessionId": "uuid",
  "projectHash": "sha256",
  "startTime": "ISO 8601",
  "lastUpdated": "ISO 8601",
  "messages": [
    {
      "id": "uuid",
      "timestamp": "ISO 8601",
      "type": "user",
      "content": [{ "text": "..." }]
    },
    {
      "id": "uuid",
      "timestamp": "ISO 8601",
      "type": "gemini",
      "content": "markdown string",
      "thoughts": [{ "subject": "...", "description": "...", "timestamp": "..." }],
      "tokens": { "input": N, "output": N, "cached": N, "thoughts": N, "tool": N, "total": N },
      "model": "gemini-3.1-pro-preview",
      "toolCalls": [{
        "id": "string",
        "name": "tool_name",
        "args": {},
        "result": [{ "functionResponse": { "id": "...", "name": "...", "response": { "output": "..." } } }],
        "status": "success|cancelled",
        "timestamp": "ISO 8601",
        "displayName": "Human-readable name",
        "description": "Tool description"
      }]
    },
    {
      "id": "uuid",
      "type": "error",
      "content": "error string"
    },
    {
      "id": "uuid",
      "type": "info",
      "content": "info string"
    }
  ],
  "kind": "main",
  "summary": "Session summary"
}
```

### Key Differences from Claude/Codex

| Aspect | Claude | Codex | Gemini |
|---|---|---|---|
| Session format | JSONL (append-only) | JSONL (append-only) | Single JSON (rewritten) |
| Watcher strategy | Byte offset tracking | Byte offset tracking | File size guard + message ID tracking |
| Hook protocol | HTTP POST (url-based) | HTTP POST (command curl) | stdin/stdout JSON (needs bridge script) |
| Tool tracking | Separate tool_use/tool_result entries | JSONL entries | Embedded in gemini message as toolCalls[] |
| Thinking | Pane monitor detection | Pane monitor detection | In JSON (thoughts[]) + pane monitor |
| Token/model info | statusLine hook | JSONL entries | In JSON (tokens{}, model field) |
| Session ID | Pre-assigned via --session-id | Discovered from SessionStart hook | Discovered from SessionStart hook |
| Permission toggle | Shift+Tab cycles 4 modes | N/A | Ctrl+Y toggles YOLO on/off |
| Model switch | /model slash command | N/A | /model slash command |

## File Structure

### New Files

```
server/adapters/shared/
  tmux-manager.ts              # Moved from claude/ (shared by all 3 adapters)

server/adapters/gemini/
  index.ts                     # GeminiAdapter (extends IAdapter)
  gemini-tmux-adapter.ts       # Session lifecycle, hook handling
  pane-monitor.ts              # Gemini TUI streaming/thinking detection
  transcript-parser.ts         # JSON session -> ParsedMessage[]
  json-store.ts                # Session discovery from ~/.gemini/tmp/
  message-utils.ts             # Gemini content block extraction
  hook-config.ts               # GeminiHookConfig (install/uninstall hooks)
  bridge.sh                    # stdin JSON -> curl POST bridge script

server/stores/
  json-watcher.ts              # New: JSON file watcher (alongside existing jsonl-watcher.ts)
```

### Modified Files

```
server/adapters/shared/tmux-manager.ts    # Moved from server/adapters/claude/tmux-manager.ts
server/adapters/claude/tmux-adapter.ts    # Update import path -> ../shared/tmux-manager.js
server/adapters/codex/codex-tmux-adapter.ts  # Update import path -> ../shared/tmux-manager.js
server/adapters/init.ts                   # Add gemini loader
server/adapters/registry.ts              # Add 'gemini' to default enabled list
bin/hooks-cli.mjs                        # Add GeminiHookConfig
bin/codetap                              # Add gemini to set_adapter, detection, labels, validation
src/lib/adapter-brands.ts                # Add gemini brand + extend iconType union to include 'gemini'
src/components/AdapterIcon.tsx           # Add GeminiIcon (SVG from thesvg.org), refactor to switch/map
```

## Component Designs

### 1. Bridge Script (`bridge.sh`)

Gemini hooks communicate via stdin JSON / stdout JSON. The bridge reads stdin and POSTs to the code-tap server, matching the existing HTTP-based pattern.

```bash
#!/bin/bash
# Reads JSON from stdin (Gemini hook protocol), POSTs to code-tap server.
#
# IMPORTANT: Gemini hooks expect a JSON response on stdout. We must write
# a response BEFORE backgrounding the curl POST, or Gemini will hang.
# Exit code 0 = allow (continue), exit code 2 = block.
#
# Shell compatibility: Uses #!/bin/bash for /dev/tcp port check.
# If Gemini executes hooks with zsh (which lacks /dev/tcp), fall back to
# curl's --connect-timeout instead. Validated against Gemini CLI v0.34.0.
ENDPOINT="$1"
PORT="${CODETAP_PORT:-3456}"
PROTOCOL="${CODETAP_PROTOCOL:-http}"
CURL_K=""
[ "$PROTOCOL" = "https" ] && CURL_K="-k"

# Read stdin (Gemini hook JSON payload)
input=$(cat)

# Respond to Gemini immediately — must happen BEFORE backgrounding curl.
# Empty JSON object = "no modifications, continue normally".
printf '{}'

# Port check: skip curl if server isn't listening (fail-fast <1ms)
(echo >/dev/tcp/localhost/$PORT) 2>/dev/null || exit 0

# Forward payload to code-tap server asynchronously
printf '%s' "$input" | curl -sf $CURL_K --connect-timeout 2 --max-time 5 \
  -X POST -H 'Content-Type:application/json' -d @- \
  "${PROTOCOL}://localhost:${PORT}/api/hooks/gemini/${ENDPOINT}" &>/dev/null &
```

### 2. GeminiHookConfig (`hook-config.ts`)

Installs hooks into `~/.gemini/settings.json` under the `hooks` key. Follows the same wrap pattern as Claude/Codex — preserves existing hooks, identifies our entries by portTag for clean uninstall.

**Hook mapping:**

| Gemini Event | Bridge Endpoint | Purpose |
|---|---|---|
| `BeforeTool` | `before-tool` | tool-start event |
| `AfterTool` | `after-tool` | tool-done event |
| `BeforeAgent` | `before-agent` | processing-started |
| `AfterAgent` | `after-agent` | session-idle (stop) |
| `SessionStart` | `session-start` | Session registration, watcher setup |
| `SessionEnd` | `session-end` | Cleanup |

**Hook command format:**
```json
{
  "hooks": {
    "BeforeTool": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "/abs/path/to/bridge.sh before-tool",
        "timeout": 2
      }]
    }]
  }
}
```

Environment variables `CODETAP_PORT` and `CODETAP_PROTOCOL` are set in the command string so the bridge knows where to POST.

### 3. JsonWatcher (`server/stores/json-watcher.ts`)

Watches a single JSON session file for new messages. Cannot use byte-offset tracking (file is rewritten entirely on each update), so uses file-size guard + message ID tracking.

**Algorithm:**
1. `fs.watch()` triggers on file change (+ fallback polling every 2s)
2. `stat()` checks if file size changed — skip if same (filters false positives)
3. Read entire file, `JSON.parse()`
4. Compare `messages.length` vs `_lastMessageCount`
5. Find new messages by scanning from `_lastMessageCount` index
6. Verify with `_lastMessageId` (guard against message deletion/modification edge case)
7. Emit only new messages via `onNewMessages()` callback
8. Update `_lastSize`, `_lastMessageCount`, `_lastMessageId`

**Debounce:** 50ms after `fs.watch` fires before polling. Chosen to balance latency (streaming UX) vs coalescing (Gemini rewrites the file on each message). The existing `JsonlWatcher` uses no debounce because JSONL appends are atomic; JSON rewrites are not.

**Performance:** Observed session files up to ~34KB in practice. `JSON.parse()` of 34KB takes <1ms. As a safeguard: if file size exceeds 2MB, log a warning. The in-memory parsed result is NOT cached between polls (file is always re-read on size change) — this keeps the watcher stateless and avoids stale-cache bugs.

**API (consistent with JsonlWatcher):**
```typescript
start(options?: { skipExisting?: boolean }): void
stop(): void
pollNow(): void
onNewMessages(cb: (messages: GeminiSessionMessage[]) => void): void
onError(cb: (err: Error) => void): void
```

### 4. GeminiTranscriptParser

Converts Gemini JSON messages to the shared `ParsedMessage` format used by the frontend.

**Type mapping:**
- `type: "user"` -> `role: "user"`, content normalized to `ContentBlock[]`
- `type: "gemini"` -> `role: "assistant"`, content + toolCalls merged into `ContentBlock[]`
- `type: "error"` -> emitted as `session-error` event (visible to user — rate limits, API key issues, etc.)
- `type: "info"` -> skipped (internal CLI messages like "Press F12 for diagnostics")

**Tool call conversion:**
Gemini embeds tool calls in the gemini message as `toolCalls[]`. Each tool call has `id`, `name`, `args`, `result`, `status`. These are converted to standard `tool_use` + `tool_result` ContentBlocks to match the Claude adapter's output format.

**Thinking extraction:**
Gemini includes `thoughts[]` in the JSON. These are emitted as `thinking` events and optionally included in the message content as thinking blocks.

**Token/model extraction:**
`tokens` and `model` fields are extracted and emitted as `status-update` events, providing context%, model, and cost info without needing a statusLine hook.

### 5. GeminiJsonStore (`json-store.ts`)

Session discovery for Gemini's file structure. Maps to `SessionInfo` interface.

**Discovery algorithm:**
1. Read `~/.gemini/projects.json` to get `{ projects: { "/abs/path": "project-name" } }`
2. For a given `dir` (cwd), find matching project name from the mapping
3. List `~/.gemini/tmp/<project-name>/chats/session-*.json` files
4. For each file: read JSON, extract `sessionId`, `startTime`, `lastUpdated`, `summary`, first user message text, model from latest gemini message
5. Return `SessionInfo[]` sorted by `lastUpdated` descending

**Key functions:**
- `getSessions(dir?, limit?)` — List sessions for a project (or all projects)
- `getMessages(sessionId, dir?)` — Read and parse a session file, return `ParsedMessage[]`
- `findSessionFile(sessionId)` — Scan all project dirs to locate a session file by UUID
- `getProjectName(dir)` — Look up project name from `projects.json`

**Project root resolution:**
Each `~/.gemini/tmp/<project-name>/.project_root` file contains the absolute path. Use this to map back from project-name to cwd for display.

### 6. GeminiAdapter Capabilities

```typescript
{
  supportsPlanMode: true,          // --approval-mode plan
  supportsPermissionModes: true,   // default, auto_edit, yolo, plan
  supportsInterrupt: true,         // Ctrl+C in tmux
  supportsResume: true,            // gemini --resume
  supportsAttach: false,           // TBD
  supportsStatusLine: false,       // No statusLine hook (token info from JSON)
  supportsImages: true,
  supportsStreaming: true,
  maxContextWindow: 1000000,       // 1M tokens
  permissionModeType: 'toggle',    // Ctrl+Y toggles YOLO (not cycle like Claude)
}
```

**Effort levels:** Gemini CLI does not expose a reasoning effort parameter. `getEffortLevels()` returns `[]`.

**Permission mode runtime behavior:**
- `auto_edit` and `plan` can only be set at session launch via `--approval-mode`
- At runtime, Ctrl+Y is a binary toggle: `default` <-> `yolo`
- `switchPermissionMode()` for `auto_edit`/`plan` mid-session: not supported, returns `false`
```

**Models:**
- `auto` — Dynamic resolution (default)
- `pro` — Gemini 2.5 Pro (complex reasoning)
- `flash` — Gemini 2.5 Flash (fast, balanced)
- `flash-lite` — Gemini 2.5 Flash Lite (fastest)

**Permission modes:**
- `default` — Prompts for each tool call
- `auto_edit` — Auto-approves file edits
- `yolo` — Auto-approves everything
- `plan` — Read-only (experimental)

### 7. Session Lifecycle

**Start:**
```
gemini --approval-mode <mode> -m <model> -i "<prompt>"
```
- Session ID discovered from SessionStart hook's `session_id` field
- Uses `_pendingHookBodies` pattern (same as Codex) to handle race condition
- Must emit `'session-rekeyed'` event when temp session key is replaced with real UUID from hook (same as Codex's `session-rekeyed` pattern — SessionManager re-registers WS clients under new ID)

**Resume:**
```
gemini --resume <session-id>
```

**Permission mode switch:**
- Ctrl+Y in tmux toggles YOLO on/off
- Only binary toggle (not 4-way cycle like Claude's Shift+Tab)

**Model switch:**
- `/model <name>` slash command via tmux sendKeys

### 8. CLI & Frontend Changes

**`bin/codetap`:**
- `set_adapter()`: add `gemini` case with `YOLO="--approval-mode yolo"`
- Adapter detection: add `*gemini*` pattern
- ANSI label: `\033[34m[Gemini]\033[0m` (blue)
- `--adapter` validation: add `gemini` case

**`bin/hooks-cli.mjs`:**
- Import and instantiate `GeminiHookConfig`
- Add to install/uninstall calls

**`server/adapters/init.ts` + `server/adapters/registry.ts`** (atomic — must land together):
- `init.ts`: Add `gemini` loader in `LOADERS` map
- `registry.ts`: Add `'gemini'` to default `enabledAdapters` list
- If one changes without the other, the adapter either loads but isn't enabled, or is enabled but fails to load

**`src/lib/adapter-brands.ts`:**
```typescript
gemini: {
  id: 'gemini',
  displayName: 'Gemini',
  provider: 'Google',
  color: '#4285f4',
  colorBg: '#4285f422',
  gradient: 'linear-gradient(135deg, #4285f4, #1a73e8)',
  glow: 'rgba(66,133,244,0.3)',
  iconType: 'gemini',
}
```

**`src/components/AdapterIcon.tsx`:**
- Add `GeminiIcon` component with official Google Gemini SVG from thesvg.org
- Add `'gemini'` case to iconType switch

### 9. Shared Layer Refactor

**Move `tmux-manager.ts`:**
- From: `server/adapters/claude/tmux-manager.ts`
- To: `server/adapters/shared/tmux-manager.ts`
- Update imports in:
  - `server/adapters/claude/tmux-adapter.ts`
  - `server/adapters/claude/pane-monitor.ts`
  - `server/adapters/codex/codex-tmux-adapter.ts`
  - `server/adapters/gemini/gemini-tmux-adapter.ts`

No logic changes — pure file move + import path updates.

## Data Flow

```
Gemini CLI (tmux)
    |
    +-- Hook (stdin JSON) --> bridge.sh --> POST /api/hooks/gemini/<event>
    |     |
    |   GeminiTmuxAdapter.handle{Event}()
    |     |
    |   emit('tool-start', 'tool-done', 'session-idle', etc.)
    |
    +-- Session JSON file (~/.gemini/tmp/<project>/chats/session-*.json)
    |     |
    |   JsonWatcher detects file change (fs.watch + polling)
    |     |
    |   Reads JSON, diffs messages by count + ID
    |     |
    |   GeminiTranscriptParser.parse(newMessages)
    |     |
    |   emit('new-messages', messages[])
    |   emit('status-update', { model, tokens })
    |   emit('thinking', { thoughts[] })
    |
    +-- tmux pane output (streaming)
          |
        GeminiPaneMonitor detects changes
          |
        emit('streaming-text')

All events --> SessionManager --> WebSocket --> React frontend
```

## Testing Strategy

- Unit tests for `GeminiTranscriptParser` (convert JSON messages to ParsedMessage[])
- Unit tests for `JsonWatcher` (file size guard, message ID tracking, debounce)
- Unit tests for `GeminiHookConfig` (install/uninstall preserves existing hooks)
- Integration test: start Gemini session via API, verify WebSocket events
- Manual test: full flow on phone (start, send prompt, see streaming, approve tool, resume)
