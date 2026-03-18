<div align="center">

<h1>
  <img src="public/claw-logo.svg" height="40" alt="ClawTap" />&nbsp;&nbsp;ClawTap
</h1>

### Your AI coding sessions, in your pocket.

One mobile interface for Claude Code, Codex CLI, and Gemini CLI.
Real-time sync. Cross-AI review. Push notifications.

[![npm version](https://img.shields.io/npm/v/@kuannnn/clawtap.svg)](https://www.npmjs.com/package/@kuannnn/clawtap) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg)](https://nodejs.org/)

---

**[Quick Start](#-quick-start)** · **[Adapters](#-multi-adapter-support)** · **[Cross-AI Review](#-cross-ai-review)** · **[CLI](#-cli)** · **[PWA & Notifications](#-pwa--push-notifications)** · **[Architecture](#-architecture)**

</div>

<br>

> Walk away from your desk while your AI is working. Get a push notification when it finishes. Approve a file edit from the couch. Send Claude's code to Gemini for a second opinion. Start a task on the train. Your phone and terminal share the exact same AI session — no duplicates, no sync issues, no matter which AI you're using.

```
📱 Phone (PWA) ◄── WebSocket ──► 🖥 Server ◄── tmux ──► 🤖 Claude / Codex / Gemini
       ▲                            │                          ▲
  Push Notify                    HTTPS                    💻 Terminal
  (Web Push)                  (Tailscale)
```

<br>

## 🚀 Quick Start

```bash
npm install -g @kuannnn/clawtap

export CLAUDE_UI_PASSWORD=your-password
clawtap
```

Open the URL on your phone. That's it.

ClawTap auto-detects which AI CLIs you have installed (`claude`, `codex`, `gemini`) and enables them automatically.

<details>
<summary>📦 Install from source</summary>
<br>

```bash
git clone https://github.com/kuan0808/clawtap.git
cd clawtap && npm install && npm run build && npm link
```

</details>

<br>

## 🤖 Multi-Adapter Support

ClawTap works with three AI coding assistants through a unified interface:

| Adapter | CLI | Models | Context | Permission Modes |
|---------|-----|--------|---------|-----------------|
| **Claude Code** | `claude` | Sonnet, Opus, Haiku, Opus 1M, Sonnet 1M | 200K–1M | Normal, Auto-edit, Plan, YOLO |
| **Codex CLI** | `codex` | GPT-5.4, GPT-5.3 Codex, GPT-5.2 series, and more | 258K | Suggest, Full Auto, Untrusted, YOLO |
| **Gemini CLI** | `gemini` | Auto, Gemini Pro, Gemini Flash, Flash Lite | 1M | Default, Auto Edit, Plan, YOLO |

Each adapter auto-detects at startup. Start a session from your phone's **New Chat** screen — tap the adapter icon to switch between available AIs, pick a model, and go. Or from the terminal:

```bash
clawtap new                       # Claude (default)
clawtap new --adapter codex       # Codex
clawtap new --adapter gemini      # Gemini
```

The UI adapts to each adapter — different models, permission modes, effort levels, and branding. But the workflow is identical: send a message, see the response stream in, approve or deny tool calls, switch modes.

<br>

## 🔀 Cross-AI Review

Send any AI's response to a different AI for a second opinion — the killer feature that makes multi-adapter worth it.

**How it works:**

1. Tap **↗ Send to** on any assistant message
2. Pick a target adapter (e.g., send Claude's code to Codex)
3. Choose a model and optionally attach instructions ("Review for security issues")
4. A review panel slides up with the child AI's conversation
5. The child AI can **send back** its findings to the parent chat

**Multi-review tabs:** Run multiple reviews simultaneously. Each review gets its own tab in the floating panel — switch between them, minimize to a compact bar, or expand to see the full conversation. Each tab maintains its own independent WebSocket connection.

**Send to existing review:** When reviews are already active, tapping Send to shows a shortcut sheet — send directly to a running review or start a new one.

**Review markers:** Visual timeline markers show exactly where each review started in the parent chat, with a collapsed card to tap and view the review history. "Review ended" appears at the position in the chat where you pressed End.

<br>

## ✨ Features

### Live Streaming

See AI responses **as they're being written** — not after they finish. Thinking indicators update in real-time. Tool calls appear as inline cards with live status transitions. Context usage and cost stream to your status bar.

### Mobile Permission Control

Slide-up overlay with the exact tool name, file path, and command. Allow, Allow All, or Deny with a 120-second countdown. Switch between permission modes mid-session with a single tap on the status bar. Your terminal shows the same prompt — answer from whichever device is closer.

### Rich Tool Visualization

Every tool call renders as an expandable card:

| Tool | What You See |
|------|-------------|
| **Edit** | Inline red/green diff preview → full-screen diff viewer |
| **Write** | File path + content preview with line count |
| **Read / Bash / Grep** | Input/output with syntax highlighting |
| **Agent** | Collapsible group with progress indicators |

### Queue & Continue

Send follow-up messages while the AI is still responding. They appear as "Queued" with Edit/Cancel and auto-send when the AI finishes. Paste images from clipboard with thumbnail preview.

### Voice Input

Tap the mic icon to dictate coding instructions. Uses the Web Speech API with real-time interim transcription. Works in any language.

### Smart Input

Type `ultrathink` or `megathink` and watch the rainbow shimmer animation. Drafts auto-save to localStorage. Images can be attached from gallery or clipboard.

### Session Management

Browse projects by directory. Filter by adapter (Claude / Codex / Gemini tabs). See session previews with first message, timestamps, and active indicators. The **Active** tab shows running sessions across all projects with real-time refresh, client count, and notification badges.

<br>

## 💻 CLI

```bash
clawtap                                    # Start server, show URLs
clawtap new [--adapter codex|gemini]       # New session
clawtap --continue [--adapter gemini]      # Resume most recent session
clawtap --resume <session-id>              # Resume specific session
clawtap -a [--adapter codex]              # Active sessions (current project)
clawtap -A [--adapter gemini]             # Active sessions (all projects)
clawtap hooks install [--adapter claude]   # Install hooks (all or one adapter)
clawtap hooks uninstall [--adapter gemini] # Remove hooks
clawtap cert                               # Generate HTTPS certificate
clawtap stop                               # Graceful shutdown
```

The `--adapter` flag works with every command. Session lists show colored `[Claude]`/`[Codex]`/`[Gemini]` labels with first-prompt previews.

Auto-starts the server on first use. Sessions are instantly visible on mobile.

<br>

## 🔔 PWA & Push Notifications

### Setup

**1. Enable HTTPS** (required for push):

```bash
# Option A: Tailscale (recommended — zero cert management)
tailscale serve --bg 3456

# Option B: Self-signed certificate
clawtap cert
```

**2. Install PWA:** Open the URL in Safari → Share → **Add to Home Screen**.

**3. Enable notifications:** Open ClawTap from home screen → tap the **bell icon** → Allow.

### Smart Notifications

| Event | When | Notification |
|-------|------|-------------|
| AI finishes | Only if you're NOT viewing that session | "Turn complete in project-name" |
| Permission needed | Only if you're NOT viewing that session | Tool name + project |
| Question asked | Only if you're NOT viewing that session | "Waiting for answer" |

The app icon badge shows how many sessions have unread notifications. Entering a session clears its count.

<br>

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_UI_PASSWORD` | *(required)* | Login password |
| `PORT` | `3456` | Server port |

HTTPS is enabled automatically when `~/.clawtap/cert.pem` and `~/.clawtap/key.pem` exist. Otherwise the server runs on HTTP. Tailscale Serve is the easiest path to HTTPS.

Hooks auto-configure on startup and clean up on `clawtap stop`. If you have existing hooks (e.g., custom statusLine), ClawTap wraps them — both coexist.

<br>

## 🏗 Architecture

### Three-Channel Event System

Each adapter feeds the UI through three independent, non-blocking channels:

| Channel | Latency | Role |
|---------|---------|------|
| **Hooks** | ~1ms | Tool events, permissions, session lifecycle — fire-and-forget, never blocks the AI |
| **File Watcher** | ~2s | Message transcripts (JSONL for Claude/Codex, JSON for Gemini) — single source of truth |
| **Pane Monitor** | 500ms | Streaming text preview, thinking detection — ephemeral UX signals via tmux |

### Adapter Plugin Architecture

```
IAdapter (EventEmitter)
  ├── ClaudeAdapter    ← HTTP hooks, JSONL watcher, pane monitor
  ├── CodexAdapter     ← Command hooks, JSONL watcher, pane monitor
  └── GeminiAdapter    ← Shell bridge hooks, JSON watcher, pane monitor
```

Each adapter is self-contained: hook configuration, session file discovery, transcript parsing, tmux lifecycle, permission management. Adding a new AI CLI means implementing one class — the server, WebSocket protocol, and frontend work unchanged.

### Data Flow

```
AI CLI (Claude/Codex/Gemini)
  │
  ├── Hooks → POST /api/hooks/:adapter/:event → SessionManager → WebSocket → Phone
  ├── Session Files → Watcher → new-messages event → WebSocket → Phone
  └── tmux pane → PaneMonitor → text-delta/thinking → WebSocket → Phone

Phone
  └── Send message → WebSocket → SessionManager → tmux sendKeys → AI CLI
```

### Storage

SQLite with WAL mode. Stores review history, push subscriptions, rate limiting, saved instructions, and session stats. Session messages live in the AI CLI's own files — ClawTap reads them, never writes.

<br>

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| No response after sending | `tmux list-windows -t clawtap` — check if the AI process is alive |
| `clawtap` not found | `npm install -g @kuannnn/clawtap` |
| Stale sessions | `tmux kill-session -t clawtap` |
| Port in use | `lsof -i :3456` then `kill <PID>` |
| Hooks not cleaned after crash | `clawtap hooks uninstall` or `clawtap stop` |
| Push notifications not working | Ensure HTTPS + PWA installed from home screen |
| Adapter not showing | Check that the CLI is installed: `which claude`, `which codex`, `which gemini` |
| Gemini hooks failing | Verify timeout is in milliseconds (5000, not 5) |

<br>

## 📄 License

MIT
