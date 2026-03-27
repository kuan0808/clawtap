# Interactive Prompts — Normalized Handling Across All Adapters

**Date**: 2026-03-27
**Status**: Draft

## Problem

Gemini and Codex CLIs show interactive terminal prompts (tool confirmation, ask user question, plan approval, etc.) that ClawTap doesn't detect or handle. The UI freezes with a blinking cursor while the CLI waits for input. Claude's prompts are handled via hooks, but Gemini/Codex have no equivalent hook mechanism for runtime prompts.

## Design Principle

**One normalized format, adapter-agnostic frontend.**

Each adapter detects prompts in its own way (Claude: hooks, Gemini/Codex: pane monitor), but all emit the same `InteractivePrompt` format. Frontend renders based on format, not adapter identity.

## Normalized Types

```typescript
interface InteractivePrompt {
  requestId: string;
  type: 'permission' | 'question' | 'plan' | 'loop-detected';
  title: string;
  description: string;
  toolName?: string;
  toolInput?: any;
  options?: { value: string; label: string }[];
  textInput?: { placeholder?: string };
}

interface PromptResponse {
  requestId: string;
  selectedOption?: string;
  textValue?: string;
}
```

Render logic:
- `options` only → button list (permission overlay)
- `textInput` only → text input field (ask question)
- Both → buttons + text field (plan mode: approve buttons + feedback)

## Changes

### Change 1: Gemini pane monitor — detect interactive prompts

**File:** `server/adapters/gemini/pane-monitor.ts`

Add prompt detection to the existing poll loop. Each poll, check for known prompt patterns before processing streaming text:

**Tool Confirmation** ("Action Required"):
```
Pattern: content includes "Action Required" AND numbered options (● N.)
Extract: title, description (command/file/tool info), options list
Emit: { type: 'permission', options: [...] }
```

**AskUser** ("Answer Questions"):
```
Pattern: content includes "Answer Questions" AND "> " input prompt
Extract: question text, input type (detect options vs free text)
Emit: { type: 'question', textInput or options }
```

**Plan Approval** ("Approval"):
```
Pattern: content includes "Approval" header with plan content
Extract: plan text, approval options + feedback field
Emit: { type: 'plan', options: [...], textInput: { placeholder: 'Type your feedback...' } }
```

**Loop Detection**:
```
Pattern: content includes "potential loop was detected"
Extract: options
Emit: { type: 'loop-detected', options: [...] }
```

Dedup: track last emitted requestId to avoid re-emitting the same prompt on each poll.

### Change 2: Codex pane monitor — detect interactive prompts

**File:** `server/adapters/codex/pane-monitor.ts`

**Command/File/Network Approval**:
```
Pattern: content includes "(y) Yes, proceed" or "Would you like to run"
Extract: command/file info, available options (y/a/p/d/n)
Emit: { type: 'permission', options: [...] }
```

**Request User Input**:
```
Pattern: content includes "Question" header with "> " input
Extract: question text, options or free text field
Emit: { type: 'question', textInput or options }
```

### Change 3: Gemini adapter — respondPermission / respondQuestion

**File:** `server/adapters/gemini/gemini-tmux-adapter.ts`

Add methods to send keystrokes based on `PromptResponse`:

- **Permission (numbered options):** Navigate Down × N to selected option, press Enter
- **Question (text):** Type answer text, press Enter
- **Question (select):** Navigate to selected option, press Enter
- **Plan:** Select approve option OR type feedback, press Enter

### Change 4: Codex adapter — respondPermission / respondQuestion

**File:** `server/adapters/codex/codex-tmux-adapter.ts`

- **Permission:** Send the keyboard shortcut key (y/a/p/d/n)
- **Question (text):** Type answer text, press Enter
- **Question (select):** Navigate to option, press Enter

### Change 5: Claude adapter — normalize existing events

**File:** `server/adapters/claude/tmux-adapter.ts`

Current `permission-request` and `ask-question` events already work but use adapter-specific format. Map to `InteractivePrompt` format in session-manager.ts event handlers (minimal change — add missing fields).

### Change 6: Session manager — unified event handling

**File:** `server/session-manager.ts`

Current event listeners:
```typescript
adapter.on('permission-request', ...) → broadcast WS.PERMISSION_REQUEST
adapter.on('ask-question', ...) → broadcast WS.PERMISSION_REQUEST (toolName: 'AskUserQuestion')
```

Change to emit unified format:
```typescript
adapter.on('interactive-prompt', (sessionId, prompt: InteractivePrompt) => {
  broadcast(sessionId, { type: WS.INTERACTIVE_PROMPT, ...prompt });
});
```

### Change 7: Frontend — InteractivePromptOverlay component

**File:** `src/components/InteractivePromptOverlay.tsx` (new)

Replaces `PermissionOverlay` and `AskQuestion` with a single adapter-agnostic component:

- Renders `title` + `description`
- If `options` → button list
- If `textInput` → text input field
- If both → buttons + text field (plan mode layout)
- Sends `PromptResponse` back via WS

**File:** `src/components/ChatView.tsx` + `src/components/FloatingReviewPanel.tsx`

Replace `PermissionOverlay` / `AskQuestion` usage with `InteractivePromptOverlay`.

### Change 8: useChat — handle new WS message type

**File:** `src/hooks/useChat.ts`

Replace `WS.PERMISSION_REQUEST` handler with `WS.INTERACTIVE_PROMPT`:
```typescript
case WS.INTERACTIVE_PROMPT:
  setInteractivePrompt(msg); // replaces setPermissionRequest
  break;
```

### Change 9: Remaining _waitForReady prompts

**File:** `server/adapters/gemini/gemini-tmux-adapter.ts`

Add detection for remaining startup prompts:
- Privacy Notice → send Esc
- Multi-folder trust → send option 1
- IDE integration nudge → send "No"

These are handled in `_waitForReady` (auto-bypass), not sent to frontend.

## What Doesn't Change

- **WS protocol**: Still uses WebSocket for all communication
- **tmux management**: Still uses tmux for CLI process management
- **JSONL watching**: Still uses file watchers for message history
- **Claude hooks**: Still uses hooks for Claude tool events (just normalizes the output format)

## Scope Notes

**Phase 1 (this spec):**
- Gemini: tool confirmation, ask user, plan approval, loop detection
- Codex: command/file/network approval, request user input
- Claude: normalize existing events to new format
- Frontend: InteractivePromptOverlay component

**Phase 2 (future):**
- Diff rendering in file edit permissions
- Codex MCP elicitation forms (structured multi-field forms)
- Codex multi-agent thread approval routing
