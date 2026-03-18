# Gemini CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-featured Gemini CLI adapter to code-tap, providing bidirectional mobile control identical to the existing Claude and Codex adapters.

**Architecture:** Pluggable adapter extending `IAdapter` with three event channels (HTTP hooks via bridge script, JSON file watcher, tmux pane monitor). Shared `tmux-manager.ts` extracted to `server/adapters/shared/`. New `JsonWatcher` for Gemini's single-JSON session format.

**Tech Stack:** TypeScript, Express, fs.watch, tmux, bash (bridge script)

**Spec:** `docs/superpowers/specs/2026-03-26-gemini-adapter-design.md`

**Note:** This project has no test runner configured. Steps marked "verify" use manual checks (`npm run dev` + curl). Unit tests are noted as follow-up.

---

### Task 1: Shared Layer — Move tmux-manager.ts

**Files:**
- Create: `server/adapters/shared/tmux-manager.ts` (copy from claude/)
- Delete: `server/adapters/claude/tmux-manager.ts`
- Modify: `server/adapters/claude/tmux-adapter.ts` (import path)
- Modify: `server/adapters/claude/pane-monitor.ts` (import path)
- Modify: `server/adapters/codex/codex-tmux-adapter.ts` (import path)

- [ ] **Step 1: Create shared/ directory and move the file**

```bash
mkdir -p server/adapters/shared
git mv server/adapters/claude/tmux-manager.ts server/adapters/shared/tmux-manager.ts
```

- [ ] **Step 2: Update import in `server/adapters/claude/tmux-adapter.ts`**

Change:
```typescript
import { tmuxManager } from './tmux-manager.js';
import type { TmuxWindow } from './tmux-manager.js';
```
To:
```typescript
import { tmuxManager } from '../shared/tmux-manager.js';
import type { TmuxWindow } from '../shared/tmux-manager.js';
```

- [ ] **Step 3: Update import in `server/adapters/claude/pane-monitor.ts`**

Change:
```typescript
import { tmuxManager } from './tmux-manager.js';
```
To:
```typescript
import { tmuxManager } from '../shared/tmux-manager.js';
```

- [ ] **Step 4: Update import in `server/adapters/codex/codex-tmux-adapter.ts`**

Change:
```typescript
import { tmuxManager } from '../claude/tmux-manager.js';
```
To:
```typescript
import { tmuxManager } from '../shared/tmux-manager.js';
```

- [ ] **Step 5: Verify — server starts without errors**

```bash
npx tsx server/index.ts
```
Expected: Server starts, no import errors. Ctrl+C to stop.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move tmux-manager.ts to shared/"
```

---

### Task 2: JsonWatcher — New File Watcher for JSON Sessions

**Files:**
- Create: `server/stores/json-watcher.ts`

- [ ] **Step 1: Create `server/stores/json-watcher.ts`**

```typescript
// server/stores/json-watcher.ts
//
// Watches a single JSON session file for new messages.
// Unlike JsonlWatcher (byte-offset for append-only JSONL), this handles
// Gemini's single-JSON format where the entire file is rewritten on each update.
//
// Strategy: fs.watch + stat() size guard + message count/ID tracking + debounce.

import fs from 'fs';

/** A single message from a Gemini session JSON file */
export interface GeminiSessionMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini' | 'error' | 'info';
  content: unknown;
  thoughts?: unknown[];
  tokens?: Record<string, number>;
  model?: string;
  toolCalls?: unknown[];
}

/** Top-level structure of a Gemini session JSON file */
interface GeminiSessionFile {
  sessionId: string;
  projectHash?: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiSessionMessage[];
  kind?: string;
  summary?: string;
}

export interface JsonWatcherStartOptions {
  skipExisting?: boolean;
  fallbackIntervalMs?: number;
  debounceMs?: number;
}

const SIZE_WARNING_THRESHOLD = 2 * 1024 * 1024; // 2MB

export class JsonWatcher {
  filePath: string;
  private _lastSize: number = 0;
  private _lastMessageCount: number = 0;
  private _lastMessageId: string | null = null;
  private _fsWatcher: fs.FSWatcher | null = null;
  private _fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _debounceMs: number = 50;
  private _polling: boolean = false;
  private _onMessages: ((messages: GeminiSessionMessage[]) => void) | null = null;
  private _onError: ((err: Error) => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  start({ skipExisting = true, fallbackIntervalMs = 2000, debounceMs = 50 }: JsonWatcherStartOptions = {}): void {
    this._debounceMs = debounceMs;

    if (skipExisting) {
      // Read current state so we only emit future messages
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const session: GeminiSessionFile = JSON.parse(content);
        this._lastSize = fs.statSync(this.filePath).size;
        this._lastMessageCount = session.messages.length;
        if (session.messages.length > 0) {
          this._lastMessageId = session.messages[session.messages.length - 1]!.id;
        }
      } catch {}
    }

    // Primary: fs.watch for instant change notification
    try {
      this._fsWatcher = fs.watch(this.filePath, () => this._scheduleDebounce());
    } catch {
      // fs.watch may fail — fallback polling handles it
    }

    // Fallback: poll every N ms
    this._fallbackInterval = setInterval(() => this._poll(), fallbackIntervalMs);

    // Immediate first poll (catches messages if skipExisting=false)
    if (!skipExisting) this._poll();
  }

  stop(): void {
    if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  onNewMessages(cb: (messages: GeminiSessionMessage[]) => void): void { this._onMessages = cb; }
  onError(cb: (err: Error) => void): void { this._onError = cb; }

  /** Force an immediate poll (used by hooks to ensure latest state is read) */
  pollNow(): void { this._poll(); }

  /** Mark current file position — subsequent polls only return content after this point. */
  markCurrentPosition(): void {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const session: GeminiSessionFile = JSON.parse(content);
      this._lastSize = fs.statSync(this.filePath).size;
      this._lastMessageCount = session.messages.length;
      if (session.messages.length > 0) {
        this._lastMessageId = session.messages[session.messages.length - 1]!.id;
      }
    } catch {}
  }

  private _scheduleDebounce(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._poll(), this._debounceMs);
  }

  private _poll(): void {
    if (this._polling) return;
    this._polling = true;
    try {
      const stats = fs.statSync(this.filePath);

      // File size unchanged — skip (filters fs.watch false positives)
      if (stats.size === this._lastSize) {
        this._polling = false;
        return;
      }

      // Performance warning
      if (stats.size > SIZE_WARNING_THRESHOLD) {
        console.warn(`[json-watcher] Session file is ${(stats.size / 1024 / 1024).toFixed(1)}MB: ${this.filePath}`);
      }

      const content = fs.readFileSync(this.filePath, 'utf-8');
      const session: GeminiSessionFile = JSON.parse(content);
      const messages = session.messages;

      // No new messages
      if (messages.length <= this._lastMessageCount) {
        // File was rewritten but no new messages (metadata update only)
        this._lastSize = stats.size;
        this._polling = false;
        return;
      }

      // Verify continuity: if _lastMessageId is set, find its index
      let startIndex = this._lastMessageCount;
      if (this._lastMessageId) {
        // Check if the message at our expected position still matches
        const expectedMsg = messages[this._lastMessageCount - 1];
        if (expectedMsg && expectedMsg.id !== this._lastMessageId) {
          // Messages were reordered/deleted — find actual position
          const foundIndex = messages.findIndex(m => m.id === this._lastMessageId);
          startIndex = foundIndex >= 0 ? foundIndex + 1 : 0;
        }
      }

      const newMessages = messages.slice(startIndex);

      // Update tracking state
      this._lastSize = stats.size;
      this._lastMessageCount = messages.length;
      if (messages.length > 0) {
        this._lastMessageId = messages[messages.length - 1]!.id;
      }

      if (newMessages.length > 0 && this._onMessages) {
        this._onMessages(newMessages);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && this._onError) {
        this._onError(err as Error);
      }
    } finally {
      this._polling = false;
    }
  }
}
```

- [ ] **Step 2: Verify — TypeScript compiles**

```bash
npx tsc --noEmit server/stores/json-watcher.ts 2>&1 | head -20
```
Expected: No errors (or only errors from missing sibling imports, not from this file).

- [ ] **Step 3: Commit**

```bash
git add server/stores/json-watcher.ts && git commit -m "feat(gemini): add JsonWatcher for single-JSON session files"
```

---

### Task 3: Gemini Types & Message Utils

**Files:**
- Create: `server/adapters/gemini/message-utils.ts`

- [ ] **Step 1: Create `server/adapters/gemini/message-utils.ts`**

This file defines Gemini-specific types and content extraction helpers. Reference `server/adapters/claude/message-utils.ts` for the `ContentBlock` type — import it from there or from `server/types/messages.ts`.

```typescript
// server/adapters/gemini/message-utils.ts
//
// Gemini-specific types and content extraction helpers.
// Converts Gemini's JSON message format to the shared ContentBlock format.

import type { GeminiSessionMessage } from '../../stores/json-watcher.js';

// Import ContentBlock from Claude's message-utils (shared type used by all adapters).
// Do NOT re-declare — use the canonical definition to avoid type divergence.
import type { ContentBlock } from '../claude/message-utils.js';

/** Gemini tool call from session JSON */
export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: Array<{
    functionResponse: {
      id: string;
      name: string;
      response: { output?: string; error?: string };
    };
  }>;
  status: 'success' | 'cancelled' | 'error';
  timestamp: string;
  displayName?: string;
  description?: string;
  renderOutputAsMarkdown?: boolean;
}

/** Extract plain text from Gemini user message content */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}

/** Extract plain text from Gemini assistant message content */
export function extractGeminiText(content: unknown): string {
  if (typeof content === 'string') return content;
  return '';
}

/** Convert Gemini toolCalls to ContentBlock[] (tool_use + tool_result pairs) */
export function toolCallsToContentBlocks(toolCalls: GeminiToolCall[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const tc of toolCalls) {
    // tool_use block
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.args,
    });
    // tool_result block (if result exists)
    if (tc.result && tc.result.length > 0) {
      const resp = tc.result[0]!.functionResponse.response;
      blocks.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: resp.output || resp.error || '',
        is_error: tc.status === 'error' || tc.status === 'cancelled' || !!resp.error,
      });
    }
  }
  return blocks;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/adapters/gemini/message-utils.ts && git commit -m "feat(gemini): add message-utils with types and content extraction"
```

---

### Task 4: Transcript Parser

**Files:**
- Create: `server/adapters/gemini/transcript-parser.ts`

- [ ] **Step 1: Create `server/adapters/gemini/transcript-parser.ts`**

Reference `server/adapters/claude/transcript-parser.ts` for the `ParsedMessage` / `ParseResult` types. The Gemini parser is simpler because tool calls and thinking are embedded in the message JSON.

```typescript
// server/adapters/gemini/transcript-parser.ts
//
// Converts Gemini JSON session messages to the shared ParsedMessage format.
// Much simpler than Claude's parser because Gemini embeds tool calls and
// thinking directly in each message (no cross-entry tracking needed).

import type { GeminiSessionMessage } from '../../stores/json-watcher.js';
import type { ContentBlock } from '../claude/message-utils.js';
import {
  extractUserText, extractGeminiText, toolCallsToContentBlocks,
  type GeminiToolCall,
} from './message-utils.js';

/** Parsed message for frontend rendering (shared format across adapters) */
export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'plan';
  content: ContentBlock[];  // Always array — never string (consistent with Claude/Codex)
  adapter?: string;
}

/** Result of parse() */
export interface ParseResult {
  messages: ParsedMessage[];
  errors: string[];  // Error messages to emit as session-error events
}

/** Token/model info extracted from gemini messages */
export interface StatusInfo {
  model: string | null;
  tokens: Record<string, number> | null;
}

/** Thinking entry from Gemini message */
export interface ThoughtEntry {
  subject: string;
  description: string;
  timestamp: string;
}

export class GeminiTranscriptParser {
  private _msgIndex: number = 0;

  /**
   * Parse Gemini session messages into frontend-ready format.
   * Called incrementally — _msgIndex is NOT reset between calls.
   */
  parse(messages: GeminiSessionMessage[]): ParseResult {
    const parsed: ParsedMessage[] = [];
    const errors: string[] = [];

    for (const msg of messages) {
      switch (msg.type) {
        case 'user': {
          const text = extractUserText(msg.content);
          if (!text.trim()) continue;
          const userContent: ContentBlock[] = Array.isArray(msg.content)
            ? (msg.content as ContentBlock[])
            : [{ type: 'text', text }];
          parsed.push({
            id: `msg-${this._msgIndex++}`,
            role: 'user',
            content: userContent,
            adapter: 'gemini',
          });
          break;
        }
        case 'gemini': {
          const textContent = extractGeminiText(msg.content);
          const blocks: ContentBlock[] = [];

          // Add text block if present
          if (textContent) {
            blocks.push({ type: 'text', text: textContent });
          }

          // Convert embedded toolCalls to ContentBlocks
          if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
            blocks.push(...toolCallsToContentBlocks(msg.toolCalls as GeminiToolCall[]));
          }

          if (blocks.length === 0) continue;

          parsed.push({
            id: `msg-${this._msgIndex++}`,
            role: 'assistant',
            content: blocks,
            adapter: 'gemini',
          });
          break;
        }
        case 'error': {
          const errorText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          errors.push(errorText);
          break;
        }
        case 'info':
          // Skip internal CLI info messages
          break;
      }
    }

    return { messages: parsed, errors };
  }

  /** Extract thinking entries from a gemini message */
  static extractThoughts(msg: GeminiSessionMessage): ThoughtEntry[] {
    if (msg.type !== 'gemini' || !msg.thoughts || !Array.isArray(msg.thoughts)) return [];
    return msg.thoughts as ThoughtEntry[];
  }

  /** Extract status info (model, tokens) from a gemini message */
  static extractStatus(msg: GeminiSessionMessage): StatusInfo | null {
    if (msg.type !== 'gemini') return null;
    if (!msg.model && !msg.tokens) return null;
    return {
      model: (msg.model as string) || null,
      tokens: (msg.tokens as Record<string, number>) || null,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/adapters/gemini/transcript-parser.ts && git commit -m "feat(gemini): add transcript parser (JSON -> ParsedMessage)"
```

---

### Task 5: Json Store — Session Discovery

**Files:**
- Create: `server/adapters/gemini/json-store.ts`

- [ ] **Step 1: Create `server/adapters/gemini/json-store.ts`**

Reference `server/adapters/claude/jsonl-store.ts` for the `SessionInfo` type from `server/types/adapter.ts`. Gemini uses `~/.gemini/projects.json` for project mapping and `~/.gemini/tmp/<name>/chats/` for session files.

```typescript
// server/adapters/gemini/json-store.ts
//
// Session discovery for Gemini CLI sessions.
// Sessions are stored as single JSON files in ~/.gemini/tmp/<project>/chats/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from '../../types/adapter.js';
import { extractUserText } from './message-utils.js';

const GEMINI_DIR = join(homedir(), '.gemini');
const TMP_DIR = join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = join(GEMINI_DIR, 'projects.json');

/** Read ~/.gemini/projects.json -> { "/abs/path": "project-name" } */
function readProjectsMapping(): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(PROJECTS_JSON, 'utf-8'));
    return data.projects || {};
  } catch { return {}; }
}

/** Get project name for a given directory path */
export function getProjectName(dir: string): string | null {
  const mapping = readProjectsMapping();
  return mapping[dir] || null;
}

/** Get project root path from .project_root file */
function getProjectRoot(projectName: string): string | null {
  try {
    return readFileSync(join(TMP_DIR, projectName, '.project_root'), 'utf-8').trim();
  } catch { return null; }
}

/** List all project directories in ~/.gemini/tmp/ */
function listProjectDirs(): string[] {
  try {
    return readdirSync(TMP_DIR).filter(name => {
      try {
        return statSync(join(TMP_DIR, name)).isDirectory() && name !== 'bin';
      } catch { return false; }
    });
  } catch { return []; }
}

/** List session files for a specific project */
function listSessionFiles(projectName: string): string[] {
  const chatsDir = join(TMP_DIR, projectName, 'chats');
  try {
    return readdirSync(chatsDir)
      .filter(f => f.startsWith('session-') && f.endsWith('.json'))
      .map(f => join(chatsDir, f));
  } catch { return []; }
}

/** Read a session file and extract metadata */
function readSessionMeta(filePath: string): SessionInfo | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    const messages = session.messages || [];

    // Find first user message text
    const firstUser = messages.find((m: any) => m.type === 'user');
    const firstPrompt = firstUser ? extractUserText(firstUser.content) : null;

    // Find latest model from last gemini message
    let model: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'gemini' && messages[i].model) {
        model = messages[i].model;
        break;
      }
    }

    const stat = statSync(filePath);

    return {
      sessionId: session.sessionId,
      cwd: '', // Will be set by caller from project root
      lastModified: session.lastUpdated || stat.mtime.toISOString(),
      firstPrompt: firstPrompt ? firstPrompt.slice(0, 200) : null,
      model,
      // NOTE: SessionInfo type does NOT have an 'adapter' field.
      // Adapter identification happens at the API layer, not in the store.
    };
  } catch { return null; }
}

/** Get sessions for a specific directory (or all projects if dir is omitted) */
export function getSessions(dir?: string, limit: number = 50): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  if (dir) {
    const projectName = getProjectName(dir);
    if (!projectName) return [];
    const files = listSessionFiles(projectName);
    for (const file of files) {
      const meta = readSessionMeta(file);
      if (meta) { meta.cwd = dir; sessions.push(meta); }
    }
  } else {
    // All projects
    for (const projectName of listProjectDirs()) {
      const projectRoot = getProjectRoot(projectName);
      const files = listSessionFiles(projectName);
      for (const file of files) {
        const meta = readSessionMeta(file);
        if (meta) { meta.cwd = projectRoot || ''; sessions.push(meta); }
      }
    }
  }

  sessions.sort((a, b) => {
    const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
    const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
    return tb - ta;
  });
  return sessions.slice(0, limit);
}

/** Find a session file by sessionId across all projects */
export function findSessionFile(sessionId: string): string | null {
  for (const projectName of listProjectDirs()) {
    const files = listSessionFiles(projectName);
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const session = JSON.parse(content);
        if (session.sessionId === sessionId) return file;
      } catch { continue; }
    }
  }
  return null;
}

/** Get all messages from a session file */
export function getSessionMessages(sessionId: string, dir?: string): { messages: unknown[]; lastModified: string | null } {
  let filePath: string | null = null;

  if (dir) {
    const projectName = getProjectName(dir);
    if (projectName) {
      const files = listSessionFiles(projectName);
      for (const file of files) {
        try {
          const content = readFileSync(file, 'utf-8');
          const session = JSON.parse(content);
          if (session.sessionId === sessionId) { filePath = file; break; }
        } catch { continue; }
      }
    }
  }

  if (!filePath) filePath = findSessionFile(sessionId);
  if (!filePath) return { messages: [], lastModified: null };

  try {
    const content = readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    return {
      messages: session.messages || [],
      lastModified: session.lastUpdated || null,
    };
  } catch { return { messages: [], lastModified: null }; }
}
```

**Important notes for implementer:**
- `getSessionMessages()` maps to `IAdapter.getMessages()` — the GeminiAdapter (Task 9) calls `getSessionMessages` internally
- Add `listDirectory(path?)` export — reuse the pattern from Claude's `jsonl-store.ts` (reads a directory and returns `DirectoryEntry[]`). Gemini projects are rooted in whatever `.project_root` says.
- All `readFileSync` calls are acceptable for <34KB files. For `findSessionFile()` which scans all projects, consider capping at 100 files.

- [ ] **Step 2: Commit**

```bash
git add server/adapters/gemini/json-store.ts && git commit -m "feat(gemini): add json-store for session discovery"
```

---

### Task 6: Hook Config & Bridge Script

**Files:**
- Create: `server/adapters/gemini/hook-config.ts`
- Create: `server/adapters/gemini/bridge.sh`

- [ ] **Step 1: Create `server/adapters/gemini/bridge.sh`**

Copy the bridge script from the spec verbatim. Make it executable.

```bash
cat > server/adapters/gemini/bridge.sh << 'BRIDGE'
#!/bin/bash
# Reads JSON from stdin (Gemini hook protocol), POSTs to code-tap server.
#
# IMPORTANT: Gemini hooks expect a JSON response on stdout. We must write
# a response BEFORE backgrounding the curl POST, or Gemini will hang.
# Exit code 0 = allow (continue), exit code 2 = block.
ENDPOINT="$1"
PORT="${CODETAP_PORT:-3456}"
PROTOCOL="${CODETAP_PROTOCOL:-http}"
CURL_K=""
[ "$PROTOCOL" = "https" ] && CURL_K="-k"

# Read stdin (Gemini hook JSON payload)
input=$(cat)

# Respond to Gemini immediately
printf '{}'

# Port check: skip curl if server isn't listening
(echo >/dev/tcp/localhost/$PORT) 2>/dev/null || exit 0

# Forward payload to code-tap server asynchronously
printf '%s' "$input" | curl -sf $CURL_K --connect-timeout 2 --max-time 5 \
  -X POST -H 'Content-Type:application/json' -d @- \
  "${PROTOCOL}://localhost:${PORT}/api/hooks/gemini/${ENDPOINT}" &>/dev/null &
BRIDGE
chmod +x server/adapters/gemini/bridge.sh
```

- [ ] **Step 2: Create `server/adapters/gemini/hook-config.ts`**

Follow the pattern from `server/adapters/claude/hook-config.ts` — read/write `~/.gemini/settings.json`, use portTag for ownership identification, wrap (don't replace) existing hooks.

The hook-config must:
- Set `CODETAP_PORT` and `CODETAP_PROTOCOL` env vars in the command string
- Use absolute path to bridge.sh
- Install hooks for: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart`, `SessionEnd`

```typescript
// server/adapters/gemini/hook-config.ts
//
// Pure filesystem operations for Gemini CLI hook management.
// Zero runtime dependencies — no EventEmitter, no tmux, no sessions.
//
// Key differences from Claude/Codex:
// - Hooks live in ~/.gemini/settings.json under the "hooks" key
// - Uses bridge.sh (stdin JSON -> curl POST) instead of direct curl
// - No statusLine wrapping (Gemini has no statusLine hook)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HookAction {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookAction[];
}

interface GeminiSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export class GeminiHookConfig {
  port: number | string;
  useHttps: boolean;

  constructor(port?: number | string, useHttps?: boolean) {
    this.port = port || process.env.PORT || 3456;
    if (useHttps !== undefined) {
      this.useHttps = useHttps;
    } else {
      const codetapDir = join(homedir(), '.codetap');
      this.useHttps = existsSync(join(codetapDir, 'cert.pem')) && existsSync(join(codetapDir, 'key.pem'));
    }
  }

  install(): void {
    const settingsDir = join(homedir(), '.gemini');
    const settingsPath = join(settingsDir, 'settings.json');
    const { portTag } = this._hookIdentifiers();
    const desiredHooks = this._buildDesiredHooks();

    try {
      mkdirSync(settingsDir, { recursive: true });
      let existing: GeminiSettings = {};
      try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as GeminiSettings; } catch {}

      if (!existing.hooks) existing.hooks = {};

      for (const [event, configs] of Object.entries(desiredHooks)) {
        const existingEntries = existing.hooks[event] || [];
        const filtered = existingEntries.filter(entry => !this._isOurHookEntry(entry, portTag));
        existing.hooks[event] = [...filtered, ...configs];
      }

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:gemini] Auto-configured hooks in ${settingsPath}`);
    } catch (err) {
      console.warn(`[hooks:gemini] Failed to auto-configure hooks: ${(err as Error).message}`);
    }
  }

  uninstall(): void {
    const { portTag } = this._hookIdentifiers();
    const settingsPath = join(homedir(), '.gemini', 'settings.json');

    try {
      const existing: GeminiSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as GeminiSettings;

      if (existing.hooks) {
        const hookKeys = Object.keys(this._buildDesiredHooks());
        for (const key of hookKeys) {
          const entries = existing.hooks[key];
          if (!Array.isArray(entries)) continue;
          const filtered = entries.filter(entry => !this._isOurHookEntry(entry, portTag));
          if (filtered.length === 0) {
            delete existing.hooks[key];
          } else {
            existing.hooks[key] = filtered;
          }
        }
        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:gemini] Removed CodeTap hooks from ${settingsPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn(`[hooks:gemini] Failed to remove hooks: ${(err as Error).message}`);
    }
  }

  private _hookIdentifiers(): { portTag: string } {
    return { portTag: `CODETAP_PORT=${this.port}` };
  }

  private _isOurHookEntry(entry: HookEntry, portTag: string): boolean {
    return (entry.hooks || []).some(h => h.command && h.command.includes(portTag));
  }

  private _buildDesiredHooks(): Record<string, HookEntry[]> {
    const bridgePath = resolve(__dirname, 'bridge.sh');
    const protocol = this.useHttps ? 'https' : 'http';
    const envPrefix = `CODETAP_PORT=${this.port} CODETAP_PROTOCOL=${protocol}`;
    const cmd = (endpoint: string): string => `${envPrefix} ${bridgePath} ${endpoint}`;

    return {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start'), timeout: 3 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: cmd('session-end'), timeout: 3 }] }],
      BeforeTool: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('before-tool'), timeout: 3 }] }],
      AfterTool: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('after-tool'), timeout: 3 }] }],
      BeforeAgent: [{ hooks: [{ type: 'command', command: cmd('before-agent'), timeout: 3 }] }],
      AfterAgent: [{ hooks: [{ type: 'command', command: cmd('after-agent'), timeout: 3 }] }],
    };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server/adapters/gemini/hook-config.ts server/adapters/gemini/bridge.sh && git commit -m "feat(gemini): add hook-config and bridge script"
```

---

### Task 7: Pane Monitor

**Files:**
- Create: `server/adapters/gemini/pane-monitor.ts`

- [ ] **Step 1: Create `server/adapters/gemini/pane-monitor.ts`**

Follow the pattern from `server/adapters/codex/pane-monitor.ts` — takes sessionId, windowId, tmux manager, and EventEmitter. Gemini TUI patterns will need empirical refinement, so start with conservative placeholder patterns similar to Codex.

The key difference from Claude/Codex: Gemini already provides thinking in the JSON, so the pane monitor's thinking detection is supplementary (for real-time streaming before JSON is written).

```typescript
// server/adapters/gemini/pane-monitor.ts
//
// Polls tmux pane for real-time streaming output from Gemini CLI.
// Detects: streaming text, thinking indicators.
// Note: Gemini provides thinking in JSON (thoughts[]) — pane monitor
// provides real-time streaming BEFORE JSON is written to disk.

import { EventEmitter } from 'events';

interface TmuxCapture {
  capturePane(windowId: string, lines?: number): Promise<string>;
}

export interface ThinkingInfo {
  text: string;
  detail: string | null;
}

export class GeminiPaneMonitor {
  private sessionId: string;
  private windowId: string;
  private tmux: TmuxCapture;
  private emitter: EventEmitter;
  private interval: ReturnType<typeof setInterval> | null = null;
  private _lastContent: string = '';
  private _lastResponseText: string = '';

  constructor(
    sessionId: string,
    windowId: string,
    tmuxManager: TmuxCapture,
    emitter: EventEmitter,
  ) {
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.tmux = tmuxManager;
    this.emitter = emitter;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this._poll(), 500);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  async pollNow(): Promise<void> { await this._poll(); }

  private async _poll(): Promise<void> {
    try {
      const content = await this.tmux.capturePane(this.windowId);
      if (content === this._lastContent) return;
      this._lastContent = content;

      // 1. Check for thinking indicator
      const thinking = detectThinking(content);
      if (thinking) {
        this.emitter.emit('thinking', this.sessionId, thinking);
        return;
      }

      // 2. Extract streaming response text
      const text = extractResponseText(content);
      if (text && text !== this._lastResponseText) {
        this._lastResponseText = text;
        this.emitter.emit('streaming-text', this.sessionId, text);
      }
    } catch {
      // Silently ignore — tmux window may have been killed
    }
  }
}

// --- Detection functions (exported for testing) ---

/** Detect Gemini CLI thinking/processing indicators */
export function detectThinking(content: string): ThinkingInfo | null {
  const lines = content.split('\n');
  const tail = lines.slice(-15);
  for (const line of tail) {
    if (/completed|finished|done|exited/i.test(line)) continue;
    // Gemini uses braille spinners and "Thinking..." text
    const brailleMatch = line.match(/^\s*([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.+?)\s*$/);
    if (brailleMatch) return { text: brailleMatch[2]!, detail: null };
    const thinkingMatch = line.match(/^\s*(Thinking|Reasoning|Processing|Searching)(\.\.\.)?\s*(?:\((.+?)\))?\s*$/i);
    if (thinkingMatch) return { text: `${thinkingMatch[1]}...`, detail: thinkingMatch[3] || null };
  }
  return null;
}

/** Extract streaming response text from Gemini pane content */
export function extractResponseText(content: string): string {
  const lines = content.split('\n');
  // Find last user prompt (Gemini uses > or ❯)
  let lastUserPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[>❯]\s+\S/.test(lines[i]!)) { lastUserPrompt = i; break; }
  }
  if (lastUserPrompt === -1) return '';

  let responseStart = lastUserPrompt + 1;
  while (responseStart < lines.length && lines[responseStart]!.trim() === '') responseStart++;
  if (responseStart >= lines.length) return '';

  const responseLines: string[] = [];
  for (let i = responseStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[─━═\-]{5,}/.test(line.trim()) ||
        /^\s*[>❯]\s+\S/.test(line) ||
        /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/.test(line)) break;
    responseLines.push(line);
  }
  return responseLines.join('\n').trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add server/adapters/gemini/pane-monitor.ts && git commit -m "feat(gemini): add pane monitor for streaming text detection"
```

---

### Task 8: GeminiTmuxAdapter — Session Lifecycle

**Files:**
- Create: `server/adapters/gemini/gemini-tmux-adapter.ts`

- [ ] **Step 1: Create `server/adapters/gemini/gemini-tmux-adapter.ts`**

This is the largest file. Model it closely on `server/adapters/codex/codex-tmux-adapter.ts` since both share the same pattern: session ID discovered from hook, `_pendingHookBodies` for race conditions, JSONL/JSON watcher started on SessionStart hook.

Key differences from Codex:
- Uses `JsonWatcher` instead of `JsonlWatcher`
- Uses `GeminiTranscriptParser` instead of `CodexTranscriptParser`
- More hook events (BeforeTool, AfterTool, BeforeAgent, AfterAgent)
- Permission toggle via Ctrl+Y (binary YOLO toggle)
- Model switch via `/model <name>` slash command

This file is large (~400-500 lines). The implementer should:
1. Read `server/adapters/codex/codex-tmux-adapter.ts` in full
2. Copy its structure, adapting for Gemini's specifics
3. Key methods: `startSession`, `resumeSession`, `sendMessage`, `interrupt`, `switchPermissionMode`, `switchModel`, `handleSessionStart`, `handleBeforeTool`, `handleAfterTool`, `handleBeforeAgent`, `handleAfterAgent`, `handleSessionEnd`

The complete implementation is too large for inline code in this plan. The implementer should use the Codex adapter as a template and the spec's Section 7 (Session Lifecycle) for Gemini-specific behavior.

- [ ] **Step 2: Verify — file compiles**

```bash
npx tsc --noEmit server/adapters/gemini/gemini-tmux-adapter.ts 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add server/adapters/gemini/gemini-tmux-adapter.ts && git commit -m "feat(gemini): add tmux adapter for session lifecycle"
```

---

### Task 9: GeminiAdapter — Main Entry Point

**Files:**
- Create: `server/adapters/gemini/index.ts`

- [ ] **Step 1: Create `server/adapters/gemini/index.ts`**

Model on `server/adapters/codex/index.ts`. Wires the GeminiTmuxAdapter, GeminiHookConfig, and json-store together. Registers HTTP hook routes via `setup(app)`.

Key aspects:
- `static id = 'gemini'`, `static displayName = 'Gemini CLI'`, `static command = 'gemini'`
- `setup(app)`: register routes for `/api/hooks/gemini/session-start`, `before-tool`, `after-tool`, `before-agent`, `after-agent`, `session-end`
- Delegate all IAdapter methods to GeminiTmuxAdapter
- `getModels()`, `getPermissionModes()`, `getCapabilities()` as defined in spec Section 6
- `installHooks()` / `uninstallHooks()` delegate to GeminiHookConfig

Again, too large for inline code. The implementer should use `server/adapters/codex/index.ts` as a template.

- [ ] **Step 2: Verify — server starts with gemini adapter loaded**

```bash
npx tsx server/index.ts 2>&1 | head -20
```
Expected: Should see `[init] Loaded adapter: gemini` (or no error if gemini CLI not installed — registry skips it).

- [ ] **Step 3: Commit**

```bash
git add server/adapters/gemini/index.ts && git commit -m "feat(gemini): add GeminiAdapter main entry point"
```

---

### Task 10: Registration & CLI Integration

**Files:**
- Modify: `server/adapters/init.ts`
- Modify: `server/adapters/registry.ts`
- Modify: `bin/hooks-cli.mjs`
- Modify: `bin/codetap`

- [ ] **Step 1: Update `server/adapters/init.ts` — add gemini loader**

Add to `LOADERS`:
```typescript
gemini: () => import('./gemini/index.js').then(m => m.GeminiAdapter),
```

- [ ] **Step 2: Update `server/adapters/registry.ts` — add gemini to defaults**

Change line 29 from:
```typescript
: ['claude', 'codex'];
```
To:
```typescript
: ['claude', 'codex', 'gemini'];
```

- [ ] **Step 3: Update `bin/hooks-cli.mjs` — add GeminiHookConfig**

Add import:
```javascript
import { GeminiHookConfig } from '../server/adapters/gemini/hook-config.js';
```
Add instance:
```javascript
const gemini = new GeminiHookConfig();
```
Add to install/uninstall:
```javascript
if (cmd === 'install') {
  claude.install();
  codex.install();
  gemini.install();
} else {
  claude.uninstall();
  codex.uninstall();
  gemini.uninstall();
}
```

- [ ] **Step 4: Update `bin/codetap` — add gemini support**

Five changes:
1. `set_adapter()`: add `gemini) ADAPTER="gemini"; ADAPTER_CMD="gemini"; YOLO="--approval-mode yolo" ;;`
2. Adapter detection: add `*gemini*) SESS_ADAPTER="gemini" ;;`
3. ANSI label: add `gemini) LABEL="\033[34m[Gemini]\033[0m" ;;`
4. `--adapter` validation: add `gemini) set_adapter gemini ;;`
5. Help text (line ~45): update `--adapter <name>` description to `(claude, codex, gemini)`

- [ ] **Step 5: Verify — `codetap --help` shows gemini, hooks install works**

```bash
./bin/codetap --help
node bin/hooks-cli.mjs install 2>&1 | grep gemini
node bin/hooks-cli.mjs uninstall 2>&1 | grep gemini
```

- [ ] **Step 6: Commit**

```bash
git add server/adapters/init.ts server/adapters/registry.ts bin/hooks-cli.mjs bin/codetap && git commit -m "feat(gemini): wire up registration, CLI, and hook management"
```

---

### Task 11: Frontend — Adapter Brand & Icon

**Files:**
- Modify: `src/lib/adapter-brands.ts`
- Modify: `src/components/AdapterIcon.tsx`

- [ ] **Step 1: Update `src/lib/adapter-brands.ts`**

Extend the `AdapterBrand` type to include `'gemini'` in `iconType`:
```typescript
iconType: 'claude' | 'codex' | 'gemini';
```

Add gemini brand to `ADAPTER_BRANDS`:
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
},
```

- [ ] **Step 2: Update `src/components/AdapterIcon.tsx`**

1. Add `GeminiIcon` component — find the official Google Gemini star SVG from thesvg.org
2. Refactor the icon selection from if/else to a map:

```tsx
const ICON_MAP: Record<string, React.FC<{ size: number }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
};

// In AdapterIcon:
const Icon = ICON_MAP[brand.iconType] || ClaudeIcon;
return <span className={className} style={{ color: brand.color, display: 'inline-flex' }}><Icon size={size} /></span>;
```

- [ ] **Step 3: Verify — `npm run dev` builds, open browser, check adapter selector shows Gemini**

```bash
npm run dev
```
Open http://localhost:5173, check settings → adapter list shows Gemini with blue icon.

- [ ] **Step 4: Commit**

```bash
git add src/lib/adapter-brands.ts src/components/AdapterIcon.tsx && git commit -m "feat(gemini): add Gemini brand and icon to frontend"
```

---

### Task 12: End-to-End Verification

- [ ] **Step 1: Start code-tap server**

```bash
CLAUDE_UI_PASSWORD=test npm run dev
```

- [ ] **Step 2: Verify adapter registration**

```bash
curl -s http://localhost:3456/health | python3 -m json.tool
curl -sk -X POST http://localhost:3456/api/auth/login -H 'Content-Type: application/json' -d '{"password":"test"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])'
# Use token for:
curl -s http://localhost:3456/api/adapters -H 'Authorization: Bearer <token>' | python3 -m json.tool
```
Expected: Response includes `{ id: "gemini", displayName: "Gemini CLI", available: true/false, capabilities: {...} }`

- [ ] **Step 3: Verify hooks install/uninstall**

```bash
node bin/hooks-cli.mjs install
cat ~/.gemini/settings.json | python3 -m json.tool
# Should show hooks.BeforeTool, hooks.AfterTool, etc. with bridge.sh paths
node bin/hooks-cli.mjs uninstall
cat ~/.gemini/settings.json | python3 -m json.tool
# Hooks should be removed
```

- [ ] **Step 4: Verify session listing**

```bash
curl -s http://localhost:3456/api/sessions?adapter=gemini -H 'Authorization: Bearer <token>' | python3 -m json.tool
```
Expected: Returns existing Gemini sessions from `~/.gemini/tmp/*/chats/` (if any exist).

- [ ] **Step 5: Manual test — full flow (if Gemini CLI is working)**

1. Open phone browser → code-tap
2. Select Gemini adapter
3. Start new session
4. Send a prompt
5. Verify: streaming text appears, thinking shows, tool calls render
6. Resume session works

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix(gemini): end-to-end verification fixes"
```
