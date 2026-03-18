# CLI Multi-Adapter Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `codetap` CLI command support `--adapter` filtering and fix all outdated descriptions that only reference Claude.

**Architecture:** Move `--adapter` flag parsing to the top of the script (before any command handlers), so all commands can access `$ADAPTER`. Update `-a`/`-A` to filter by adapter, `--continue` to filter by adapter, and `hooks` to target specific adapters. Fix all help text and comments.

**Tech Stack:** Bash, Node.js (hooks-cli.mjs)

---

## Complete Issue List

| # | Issue | Type |
|---|---|---|
| 1 | `--adapter` parsed AFTER `-a`/`-A` exits — impossible to combine | Bug |
| 2 | `-a`/`-A` can't filter by adapter | Feature gap |
| 3 | `-a`/`-A` adapter detection uses `pane_current_command` → shows `node` not the adapter name | Bug |
| 4 | `--continue` doesn't pass adapter to resume API | Feature gap |
| 5 | `--continue` doesn't filter by adapter (always picks most recent) | Feature gap |
| 6 | `hooks install/uninstall` can't target specific adapter | Feature gap |
| 7 | Help text says "(Claude or Codex)" — missing Gemini | Text |
| 8 | Header comment says "runs Claude/Codex" — missing Gemini | Text |
| 9 | Header comment missing `--adapter` in usage examples | Text |
| 10 | No-args output doesn't mention `--adapter` | Text |
| 11 | Comment "Claude stores sessions by project dir" is outdated | Text |
| 12 | `<any args>` description unclear | Text |

## File Map

| File | Action | Responsibility |
|---|---|---|
| `bin/codetap` | Modify | Move `--adapter` parsing to top, update all commands, fix all text |
| `bin/hooks-cli.mjs` | Modify | Accept optional adapter name argument |

---

### Task 1: Move `--adapter` Parsing Before All Command Handlers

**Files:**
- Modify: `bin/codetap:24-370` (restructure flag parsing order)

The core structural fix: `--adapter` must be parsed BEFORE any command handler (including `-a`, `-A`, `--version`, `--help`), so all commands can access `$ADAPTER`.

- [ ] **Step 1: Move adapter parsing to right after variable declarations (before the `case` block)**

Move the `--adapter` parsing block (currently at lines 336-370) to immediately after line 22 (`PID_FILE=...`), before the `case "$1" in` block at line 25.

The block to move:

```bash
# --- Parse --adapter flag (before any command handlers) ---
set_adapter() {
  case "$1" in
    claude) ADAPTER="claude"; ADAPTER_CMD="claude"; YOLO="--dangerously-skip-permissions" ;;
    codex)  ADAPTER="codex";  ADAPTER_CMD="codex";  YOLO="--dangerously-bypass-approvals-and-sandbox" ;;
    gemini) ADAPTER="gemini"; ADAPTER_CMD="gemini"; YOLO="--approval-mode yolo" ;;
  esac
}

ADAPTER="claude"
ADAPTER_CMD="claude"
ADAPTER_EXPLICIT=false
prev_arg=""
for arg in "$@"; do
  if [ "$prev_arg" = "--adapter" ]; then
    ADAPTER_EXPLICIT=true
    case "$arg" in
      claude) set_adapter claude ;;
      codex)  set_adapter codex ;;
      gemini) set_adapter gemini ;;
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

Delete the old copy of this block from its current location (lines 336-370).

- [ ] **Step 2: Verify `--version` and `--help` still work**

Run:
```bash
codetap --version
codetap --help
codetap --adapter gemini --version
```
Expected: version prints, help prints, `--adapter gemini --version` still prints version (adapter is parsed but irrelevant for --version).

- [ ] **Step 3: Commit**

```bash
git add bin/codetap
git commit -m "refactor(cli): move --adapter parsing before all command handlers"
```

---

### Task 2: `-a`/`-A` Support `--adapter` Filter + Fix Adapter Detection

**Files:**
- Modify: `bin/codetap` (the `-a`/`-A` handler, lines 249-334)

- [ ] **Step 1: Add adapter filter to the session list**

The current adapter detection (lines 302-307) uses `pane_current_command` which shows `node` for all adapters — broken for detection. Fix by querying the server's `/api/active-sessions` API which has accurate adapter info.

**Note:** The `-a`/`-A` handler is already positioned AFTER `ensure_server()` and `get_auth_token()` (line 249 is after line 200/203). After Task 1 moves `--adapter` parsing to the top, `$ADAPTER` and `$ADAPTER_EXPLICIT` will be available here. No handler relocation needed.

**API note:** `/api/active-sessions` supports `?adapter=` query param but NOT `?cwd=`. For project-level filtering (`-a`), fetch all sessions and filter by `cwd` field client-side in Python.

Replace the entire `-a`/`-A` handler (lines 249-334) with:

```bash
# --- List active sessions ---
if [ "$1" = "--attach" ] || [ "$1" = "-a" ] || [ "$1" = "-A" ]; then
  ALL_MODE=false
  [ "$1" = "-A" ] && ALL_MODE=true

  # Get sessions from the server API (has accurate adapter info)
  AUTH_TOKEN=$(get_auth_token)
  if [ -n "$AUTH_TOKEN" ]; then
    SESSIONS_JSON=$(curl -s $CURL_OPTS "$PROTOCOL://localhost:$PORT/api/active-sessions" \
      -H "Authorization: Bearer $AUTH_TOKEN" 2>/dev/null)
  else
    SESSIONS_JSON="[]"
  fi

  # Filter by adapter and/or cwd client-side
  SESSIONS_JSON=$(echo "$SESSIONS_JSON" | python3 -c "
import sys, json
sessions = json.load(sys.stdin)
adapter_filter = '$ADAPTER' if '$ADAPTER_EXPLICIT' == 'true' else None
cwd_filter = '$(pwd)' if '$ALL_MODE' == 'false' else None
if adapter_filter:
    sessions = [s for s in sessions if s.get('adapter') == adapter_filter]
if cwd_filter:
    sessions = [s for s in sessions if s.get('cwd') == cwd_filter]
json.dump(sessions, sys.stdout)
" 2>/dev/null)

  # Parse and display
  COUNT=$(echo "$SESSIONS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)

  if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
    if [ "$ADAPTER_EXPLICIT" = true ]; then
      echo "No active $ADAPTER sessions."
    elif [ "$ALL_MODE" = true ]; then
      echo "No active sessions."
    else
      echo "No active sessions for project '$(basename "$(pwd)")'."
      echo "Run 'codetap -A' to see all projects, or 'codetap new' to start a new session."
    fi
    exit 0
  fi

  if [ "$ALL_MODE" = true ]; then
    HEADER="Active sessions (all projects)"
  else
    HEADER="Active sessions for $(basename "$(pwd)")"
  fi
  [ "$ADAPTER_EXPLICIT" = true ] && HEADER="$HEADER — $ADAPTER only"
  echo "$HEADER:"
  echo ""

  # Render each session
  echo "$SESSIONS_JSON" | python3 -c "
import sys, json

sessions = json.load(sys.stdin)
colors = {'claude': '\033[33m', 'codex': '\033[32m', 'gemini': '\033[34m'}
reset = '\033[0m'
home = '$HOME'

for i, s in enumerate(sessions, 1):
    adapter = s.get('adapter', '?')
    sid = s.get('sessionId', '?')
    cwd = s.get('cwd', '')
    first = s.get('firstPrompt', '')
    color = colors.get(adapter, '\033[90m')
    label = f'{color}[{adapter.capitalize()}]{reset}'

    print(f'  {i}) {label} {sid}')
    if $ALL_MODE and cwd:
        print(f'     Dir:  {cwd.replace(home, \"~\")}')
    if first:
        print(f'     {first[:60]}')
    print()
" 2>/dev/null

  # Interactive selection
  read -p "Select (1-$COUNT), or Enter to cancel: " CHOICE
  if [ -n "$CHOICE" ]; then
    TARGET=$(echo "$SESSIONS_JSON" | python3 -c "
import sys, json
sessions = json.load(sys.stdin)
idx = int('$CHOICE') - 1
if 0 <= idx < len(sessions):
    print(sessions[idx]['sessionId'])
" 2>/dev/null)
    if [ -n "$TARGET" ]; then
      tmux select-window -t "$TMUX_SESSION:$TARGET" 2>/dev/null
      tmux attach -t "$TMUX_SESSION"
    fi
  else
    echo "Cancelled."
  fi
  exit 0
fi
```

- [ ] **Step 2: Verify**

Run:
```bash
# Start a Gemini and Claude session first, then:
codetap -a                          # Current project sessions
codetap -A                          # All sessions
codetap -a --adapter gemini         # Only Gemini sessions for current project
codetap -A --adapter codex          # Only Codex sessions across all projects
```

Expected: Sessions show correct adapter labels from server (not from pane_current_command). Filter works.

- [ ] **Step 3: Commit**

```bash
git add bin/codetap
git commit -m "feat(cli): -a/-A uses server API for accurate adapter info + --adapter filter"
```

---

### Task 3: `--continue` Support `--adapter` Filter

**Files:**
- Modify: `bin/codetap` (`--continue` handler)

- [ ] **Step 1: Update `--continue` to pass adapter to API and filter by adapter**

Replace the `--continue` handler with:

```bash
elif [ "$1" = "--continue" ]; then
  shift

  # If adapter specified, find most recent session for that adapter
  if [ "$ADAPTER_EXPLICIT" = true ]; then
    AUTH_TOKEN=$(get_auth_token)
    SESSIONS_JSON=$(curl -s $CURL_OPTS "$PROTOCOL://localhost:$PORT/api/active-sessions" \
      -H "Authorization: Bearer $AUTH_TOKEN" 2>/dev/null)
    LATEST=$(echo "$SESSIONS_JSON" | python3 -c "
import sys, json
sessions = json.load(sys.stdin)
filtered = [s for s in sessions if s.get('adapter') == '$ADAPTER']
if filtered:
    # Sort by lastActivity descending
    filtered.sort(key=lambda s: s.get('lastActivity', 0), reverse=True)
    print(filtered[0]['sessionId'])
" 2>/dev/null)
  else
    # No adapter specified — find most recent tmux window
    LATEST=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_activity} #{window_name}' 2>/dev/null | grep -v " main$" | sort -rn | head -1 | awk '{print $2}')
  fi

  if [ -n "$LATEST" ]; then
    # Check if the process in the pane is still running
    PANE_CMD=$(tmux display -t "$TMUX_SESSION:$LATEST" -p '#{pane_current_command}' 2>/dev/null)
    if [ "$PANE_CMD" = "zsh" ] || [ "$PANE_CMD" = "bash" ]; then
      # CLI process exited, shell is showing — resume via API
      AUTH_TOKEN="${AUTH_TOKEN:-$(get_auth_token)}"
      BODY=$(printf '%s\n%s\n%s' "$LATEST" "$ADAPTER" "$(pwd)" | python3 -c 'import sys,json; s,a,c=sys.stdin.read().strip().split("\n"); print(json.dumps({"sessionId":s,"adapter":a,"cwd":c}))' 2>/dev/null)
      curl -s $CURL_OPTS -X POST "${PROTOCOL}://localhost:${PORT}/api/sessions/resume" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$BODY" >/dev/null 2>&1
    fi
    tmux select-window -t "$TMUX_SESSION:$LATEST"
  else
    if [ "$ADAPTER_EXPLICIT" = true ]; then
      echo "No active $ADAPTER sessions to continue"
    else
      echo "No active sessions to continue"
    fi
    exit 1
  fi

  tmux attach -t "$TMUX_SESSION"
  exit 0
```

- [ ] **Step 2: Verify**

Run:
```bash
codetap --continue                       # Resume most recent (any adapter)
codetap --continue --adapter gemini      # Resume most recent Gemini
codetap --continue --adapter codex       # Resume most recent Codex
```

- [ ] **Step 3: Commit**

```bash
git add bin/codetap
git commit -m "feat(cli): --continue supports --adapter filter + passes adapter to resume API"
```

---

### Task 4: `hooks install/uninstall` Support `--adapter` Filter

**Files:**
- Modify: `bin/codetap:84-86` (hooks handler)
- Modify: `bin/hooks-cli.mjs` (accept adapter argument)

- [ ] **Step 1: Update hooks-cli.mjs to accept optional adapter**

Replace `bin/hooks-cli.mjs`:

```javascript
#!/usr/bin/env node
// Standalone hook management — no server needed.
// Usage: node hooks-cli.mjs install|uninstall [adapter]
//   adapter: claude, codex, gemini, or omit for all
import { ClaudeHookConfig } from '../server/adapters/claude/hook-config.js';
import { CodexHookConfig } from '../server/adapters/codex/hook-config.js';
import { GeminiHookConfig } from '../server/adapters/gemini/hook-config.js';

const cmd = process.argv[2];
const adapterArg = process.argv[3]; // optional: claude, codex, gemini

if (!cmd || !['install', 'uninstall'].includes(cmd)) {
  console.error('Usage: hooks-cli.mjs install|uninstall [claude|codex|gemini]');
  process.exit(1);
}

const adapters = {
  claude: new ClaudeHookConfig(),
  codex: new CodexHookConfig(),
  gemini: new GeminiHookConfig(),
};

const targets = adapterArg ? { [adapterArg]: adapters[adapterArg] } : adapters;

if (adapterArg && !adapters[adapterArg]) {
  console.error(`Unknown adapter: ${adapterArg}. Use: claude, codex, gemini`);
  process.exit(1);
}

for (const [name, config] of Object.entries(targets)) {
  if (cmd === 'install') {
    config.install();
  } else {
    config.uninstall();
  }
}
```

- [ ] **Step 2: Update bin/codetap hooks handler to pass adapter**

Replace lines 84-86:

```bash
  hooks)
    if [ "$ADAPTER_EXPLICIT" = true ]; then
      node "$SCRIPT_DIR/hooks-cli.mjs" "$2" "$ADAPTER"
    else
      node "$SCRIPT_DIR/hooks-cli.mjs" "$2"
    fi
    exit 0 ;;
```

- [ ] **Step 3: Verify**

Run:
```bash
codetap hooks install                      # Install all
codetap hooks uninstall                    # Uninstall all
codetap hooks install --adapter gemini     # Install Gemini only
codetap hooks uninstall --adapter claude   # Uninstall Claude only
```

Wait — `--adapter` is parsed before `hooks` command, but the `hooks` case is in the early `case "$1" in` block which runs before `ensure_server`. Need to check if `--adapter` parsing happens before the case block after Task 1 moves it.

After Task 1, the parsing order is:
1. `--adapter` parsed and stripped (lines 23-55 after move)
2. `case "$1" in` — now `$1` is `hooks` (not `--adapter`)

So `codetap --adapter gemini hooks install` works. But `codetap hooks install --adapter gemini` needs the adapter parsing to handle args in any order. After Task 1's `set --` cleanup, `$1` would be `hooks` and `$2` would be `install` — correct.

But what about `codetap hooks --adapter gemini install`? The `--adapter` stripping would remove `--adapter gemini`, leaving `hooks install`. That works too.

- [ ] **Step 4: Commit**

```bash
git add bin/codetap bin/hooks-cli.mjs
git commit -m "feat(cli): hooks install/uninstall supports --adapter for single-adapter targeting"
```

---

### Task 5: Fix All Help Text and Comments

**Files:**
- Modify: `bin/codetap` (header comments, help text, no-args output)

- [ ] **Step 1: Fix header comment (lines 1-14)**

Replace with:

```bash
#!/bin/bash
# codetap — CLI wrapper that runs AI coding assistants in tmux for mobile sync
#
# Usage:
#   codetap                                    # Start server, show URLs
#   codetap new                                # New session (default: claude)
#   codetap new --adapter gemini               # New Gemini session
#   codetap --resume <session-id>              # Resume a specific session
#   codetap --continue                         # Resume the most recent session
#   codetap --continue --adapter codex         # Resume most recent Codex session
#   codetap -a                                 # List active sessions (current project)
#   codetap -a --adapter gemini                # List Gemini sessions only
#   codetap -A                                 # List ALL active sessions (all projects)
#   codetap stop                               # Stop the server (graceful cleanup)
#   codetap hooks install                      # Install hooks for all adapters
#   codetap hooks install --adapter gemini     # Install hooks for Gemini only
#   codetap cert                               # Generate self-signed HTTPS cert
#
# Adapters: claude (default), codex, gemini
# Sessions run inside tmux session "codetap".
# Mobile app auto-connects for real-time sync.
```

- [ ] **Step 2: Fix help text (lines 30-49)**

Replace with:

```bash
    cat << 'HELP'
Usage: codetap [options] [command]

Commands:
  new                    Start a new session (default: Claude)
  stop                   Stop the server (graceful cleanup)
  hooks install          Install hooks (all adapters, or use --adapter)
  hooks uninstall        Remove hooks (all adapters, or use --adapter)
  cert                   Generate self-signed HTTPS certificate

Options:
  -v, --version          Show version
  -h, --help             Show this help
  -a                     List active sessions (current project)
  -A                     List ALL active sessions (all projects)
  --adapter <name>       Adapter: claude (default), codex, gemini
  --resume <session-id>  Resume a specific session
  --continue             Resume most recent session

Examples:
  codetap new --adapter gemini          Start a Gemini session
  codetap -a --adapter codex            List active Codex sessions
  codetap --continue --adapter gemini   Continue most recent Gemini session
  codetap hooks install --adapter claude Install Claude hooks only
HELP
```

- [ ] **Step 3: Fix no-args output (lines 218-229)**

Replace with:

```bash
  echo ""
  echo "CodeTap server is running on port $PORT"
  echo ""
  echo "  Open on your phone:"
  if [ -n "$TS_HOST" ]; then echo "    https://${TS_HOST}  (Tailscale)"; fi
  if [ -n "$LAN_IP" ]; then echo "    ${PROTOCOL}://${LAN_IP}:${PORT}  (LAN)"; fi
  echo "    http://localhost:${PORT}  (this machine)"
  echo ""
  echo "  New session:   codetap new [--adapter codex|gemini]"
  echo "  Continue:      codetap --continue"
  echo "  List sessions: codetap -a"
  echo "  Stop server:   codetap stop"
  echo ""
```

- [ ] **Step 4: Remove outdated comment on line 18**

Delete line 18: `# Claude stores sessions by project dir; Codex uses date-based dirs (handled in get_project_sessions)`

- [ ] **Step 5: Verify all text output**

Run:
```bash
codetap --help
codetap --version
codetap 2>&1 | head -15
```

Verify no mention of "Claude" in contexts where it should say "adapter", and Gemini is listed everywhere.

- [ ] **Step 6: Commit**

```bash
git add bin/codetap
git commit -m "fix(cli): update all help text, comments, and output for multi-adapter support"
```

---

### Task 6: E2E Verification — All Commands × All Flags

**Files:** None (testing only)

- [ ] **Step 1: Restart server fresh**

```bash
lsof -ti :3456 | xargs kill -9 2>/dev/null
tmux kill-session -t codetap 2>/dev/null
sleep 2
export CLAUDE_UI_PASSWORD=test
CLAUDE_UI_PASSWORD=test npx tsx server/index.ts > /tmp/codetap-cli-test.log 2>&1 &
sleep 6
curl -sk https://localhost:3456/health
```

- [ ] **Step 2: Test `--version` and `--help`**

```bash
codetap --version
# Expected: codetap v1.3.2

codetap --help
# Expected: Multi-adapter help text with Examples section
# Verify: "claude (default), codex, gemini" appears
# Verify: No "Claude-only" language
```

- [ ] **Step 3: Test `codetap` (no args)**

```bash
codetap
# Expected: Server URLs + multi-adapter usage hints
# Verify: "codetap new [--adapter codex|gemini]" in output
```

- [ ] **Step 4: Test `codetap new` (all 3 adapters)**

```bash
# Create sessions using the API (non-interactive, can't attach tmux from subagent)
TOKEN=$(curl -sk -X POST "https://localhost:3456/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password":"test"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# Claude
RESULT=$(curl -sk -X POST "https://localhost:3456/api/sessions/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"adapter\":\"claude\",\"cwd\":\"$(pwd)\"}")
echo "Claude: $RESULT"

# Codex
RESULT=$(curl -sk -X POST "https://localhost:3456/api/sessions/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"adapter\":\"codex\",\"cwd\":\"$(pwd)\"}")
echo "Codex: $RESULT"

# Gemini
RESULT=$(curl -sk -X POST "https://localhost:3456/api/sessions/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"adapter\":\"gemini\",\"cwd\":\"$(pwd)\"}")
echo "Gemini: $RESULT"

# Verify tmux windows
tmux list-windows -t codetap -F '#{window_name}' | grep -v main
```

Expected: 3 session IDs returned, 3 tmux windows created.

- [ ] **Step 5: Test `-a` and `-A` with and without `--adapter`**

```bash
echo "" | codetap -a 2>&1
# Expected: Lists sessions for current project with [Claude], [Codex], [Gemini] labels

echo "" | codetap -A 2>&1
# Expected: Lists ALL sessions with Dir: info

echo "" | codetap -a --adapter gemini 2>&1
# Expected: Only Gemini sessions listed

echo "" | codetap -A --adapter codex 2>&1
# Expected: Only Codex sessions across all projects

echo "" | codetap -a --adapter claude 2>&1
# Expected: Only Claude sessions for current project
```

- [ ] **Step 6: Test `--continue` with and without `--adapter`**

Can't test tmux attach non-interactively, but verify the session selection logic:

```bash
# Check which session --continue would pick
LATEST=$(tmux list-windows -t codetap -F '#{window_activity} #{window_name}' | grep -v " main$" | sort -rn | head -1 | awk '{print $2}')
echo "Most recent (any adapter): $LATEST"

# With --adapter, verify API query works
TOKEN=$(curl -sk -X POST "https://localhost:3456/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password":"test"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
curl -sk "https://localhost:3456/api/active-sessions" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    print(f'{s[\"adapter\"]:8s} {s[\"sessionId\"][:12]}... last={s.get(\"lastActivity\",0)}')
"
```

- [ ] **Step 7: Test `hooks install/uninstall` with and without `--adapter`**

```bash
codetap hooks uninstall
# Expected: All 3 adapters' hooks removed

codetap hooks install --adapter gemini
# Expected: Only Gemini hooks installed
cat ~/.gemini/settings.json | python3 -c "import sys,json; print('hooks' in json.load(sys.stdin))"
# Expected: True

cat ~/.claude/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('hooks' in d and any('codetap' in str(v).lower() for v in d.get('hooks',{}).values()))"
# Expected: False (Claude hooks not installed)

codetap hooks install
# Expected: All 3 adapters' hooks installed

codetap hooks uninstall --adapter claude
# Expected: Only Claude hooks removed
```

- [ ] **Step 8: Test `--resume`**

```bash
# Get a session ID from the list
SID=$(tmux list-windows -t codetap -F '#{window_name}' | grep -v main | head -1)
echo "Resuming: $SID"
# Can't test tmux attach, but verify API:
TOKEN=$(curl -sk -X POST "https://localhost:3456/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password":"test"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
curl -sk -X POST "https://localhost:3456/api/sessions/resume" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"adapter\":\"claude\",\"cwd\":\"$(pwd)\"}"
# Expected: {"sessionId":"..."}
```

- [ ] **Step 9: Test `stop` and `cert`**

```bash
codetap stop
# Expected: "Stopping CodeTap server..." → "Server stopped."

# Cert already exists, just verify the command runs
echo "n" | codetap cert
# Expected: "Certificate already exists..." prompt, then exits
```

- [ ] **Step 10: Commit test results as verification log**

```bash
git add -f docs/superpowers/plans/
git commit -m "docs: CLI multi-adapter verification complete"
```
