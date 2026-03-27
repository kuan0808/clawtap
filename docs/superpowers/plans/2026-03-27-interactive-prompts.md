# Interactive Prompts Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Gemini/Codex interactive prompts from tmux pane, normalize all adapters to a single InteractivePrompt format, and render a unified overlay in the frontend.

**Architecture:** Pane monitors detect prompts and adapters emit interactive-prompt event. Session manager converts ALL prompt events (old Claude hooks + new pane detections) into WS.INTERACTIVE_PROMPT. Frontend uses a single InteractivePromptOverlay component. Response flows back via WS.PROMPT_RESPONSE and adapter sends keystrokes to tmux.

**Tech Stack:** TypeScript, React, WebSocket, tmux pane monitoring

**Spec:** docs/superpowers/specs/2026-03-27-interactive-prompts-design.md

---

## File Map

| File | Action | Change |
|---|---|---|
| server/types/messages.ts | Modify | Add InteractivePrompt, PromptResponse types |
| src/lib/ws-types.ts | Modify | Add INTERACTIVE_PROMPT, PROMPT_RESPONSE, PROMPT_DISMISSED |
| server/adapters/interface.ts | Modify | Add respondInteractivePrompt method |
| server/session-manager.ts | Modify | Convert old events to new format; add interactive-prompt listener; add handlePromptResponse; broadcast PROMPT_DISMISSED |
| server/adapters/gemini/pane-monitor.ts | Modify | Detect 4 prompt types, emit interactive-prompt |
| server/adapters/codex/pane-monitor.ts | Modify | Detect approval + user input, emit interactive-prompt |
| server/adapters/gemini/gemini-tmux-adapter.ts | Modify | Implement respondInteractivePrompt (numbered options + text) |
| server/adapters/codex/codex-tmux-adapter.ts | Modify | Implement respondInteractivePrompt (keyboard shortcuts + text) |
| server/adapters/claude/tmux-adapter.ts | Modify | Implement respondInteractivePrompt (delegates to existing) |
| src/hooks/useChat.ts | Modify | State type to InteractivePrompt; handle INTERACTIVE_PROMPT; add respondPrompt |
| src/components/InteractivePromptOverlay.tsx | Create | Unified overlay: options (buttons), textInput (field), or both (plan mode) |
| src/components/ChatView.tsx | Modify | Replace PermissionOverlay/AskQuestion with InteractivePromptOverlay |
| src/components/FloatingReviewPanel.tsx | Modify | Add prompt handling to ReviewTab |
| server/adapters/gemini/gemini-tmux-adapter.ts | Modify | _waitForReady: privacy notice, multi-folder trust, IDE nudge |

---

### Task 1: Types + WS message types

**Files:**
- Modify: server/types/messages.ts
- Modify: src/lib/ws-types.ts
- Modify: server/adapters/interface.ts

- [ ] **Step 1:** Add InteractivePrompt and PromptResponse types to server/types/messages.ts
- [ ] **Step 2:** Add INTERACTIVE_PROMPT, PROMPT_RESPONSE, PROMPT_DISMISSED to src/lib/ws-types.ts WS enum
- [ ] **Step 3:** Add respondInteractivePrompt(requestId: string, selectedOption?: string, textValue?: string): void {} to IAdapter in server/adapters/interface.ts
- [ ] **Step 4:** Commit

---

### Task 2: Session manager -- unified event conversion + response handling

**Files:**
- Modify: server/session-manager.ts

- [ ] **Step 1:** Replace existing permission-request listener to convert Claude hook data into InteractivePrompt format and broadcast as WS.INTERACTIVE_PROMPT (not WS.PERMISSION_REQUEST)

- [ ] **Step 2:** Replace existing ask-question listener to convert Claude hook data into InteractivePrompt format (detect options vs free text) and broadcast as WS.INTERACTIVE_PROMPT

- [ ] **Step 3:** Add interactive-prompt event listener for Gemini/Codex (already in InteractivePrompt format, just broadcast)

- [ ] **Step 4:** Add WS.PROMPT_RESPONSE case to handleIncomingMessage switch. Create handlePromptResponse function that calls adapter.respondInteractivePrompt and broadcasts WS.PROMPT_DISMISSED to all clients for multi-tab sync.

- [ ] **Step 5:** Commit

---

### Task 3: Gemini pane monitor -- detect prompts

**Files:**
- Modify: server/adapters/gemini/pane-monitor.ts

- [ ] **Step 1:** Add lastPromptId instance variable for dedup. At start of _poll, call _detectPrompt. If detected and different from lastPromptId, emit interactive-prompt event. If no longer detected, reset lastPromptId. Return early (skip streaming text detection while prompt is showing).

- [ ] **Step 2:** Implement _detectPrompt method. Detect 4 types:
  - Tool Confirmation: content includes "Action Required" AND numbered options pattern
  - AskUser: content includes "Answer Questions"
  - Plan Approval: content includes "Approval" AND "Yes" options AND "feedback"
  - Loop Detection: content includes "potential loop was detected"

  For each, extract title, description, options (via _parseNumberedOptions), and textInput if applicable. Return InteractivePrompt or null.

- [ ] **Step 3:** Implement _parseNumberedOptions helper. Match regex for numbered list items. Return array of { value: String(index), label } where index is 0-based.

- [ ] **Step 4:** Commit

---

### Task 4: Codex pane monitor -- detect prompts

**Files:**
- Modify: server/adapters/codex/pane-monitor.ts

- [ ] **Step 1:** Add lastPromptId + detection at start of _poll (same dedup pattern as Gemini)

- [ ] **Step 2:** Detect command/file/network approval: content includes "(y)" AND "proceed". Parse options with _parseCodexOptions matching (letter) label pattern.

- [ ] **Step 3:** Detect user input: content includes "enter to submit" AND "esc to cancel". Determine if choice or free text.

- [ ] **Step 4:** Implement _parseCodexOptions helper. Match regex for (x) Label format. Return array of { value: letter, label }.

- [ ] **Step 5:** Commit

---

### Task 5: Adapter respondInteractivePrompt implementations

**Files:**
- Modify: server/adapters/gemini/gemini-tmux-adapter.ts
- Modify: server/adapters/codex/codex-tmux-adapter.ts
- Modify: server/adapters/claude/tmux-adapter.ts

- [ ] **Step 1:** Gemini respondInteractivePrompt. If selectedOption: parse as integer index, navigate Down x index + Enter. If textValue: sendKeys text + Enter.

- [ ] **Step 2:** Codex respondInteractivePrompt. If selectedOption: sendKeys with that single character (y/a/p/d/n). If textValue: sendKeys text + Enter.

- [ ] **Step 3:** Claude respondInteractivePrompt. If textValue: delegate to existing respondQuestion. If selectedOption: delegate to existing respondPermission with value as PermissionBehavior.

- [ ] **Step 4:** Commit

---

### Task 6: Frontend -- InteractivePromptOverlay component

**Files:**
- Create: src/components/InteractivePromptOverlay.tsx

- [ ] **Step 1:** Create component with props { prompt: InteractivePrompt, onRespond: (requestId, selectedOption?, textValue?) => void }. Use BottomSheet container. Render:
  - Title bar with type badge (permission=orange, question=blue, plan=purple, loop-detected=yellow)
  - Description text
  - If toolName + toolInput: collapsible tool info card
  - If options: vertical button list
  - If textInput: text input field + submit button
  - If both options AND textInput: buttons above, text input below (plan mode)
  - 120s countdown timer

- [ ] **Step 2:** Commit

---

### Task 7: useChat -- InteractivePrompt state + respondPrompt

**Files:**
- Modify: src/hooks/useChat.ts

- [ ] **Step 1:** Add InteractivePrompt type (mirror from server types). Replace PermissionRequest state with InteractivePrompt state.

- [ ] **Step 2:** Replace WS.PERMISSION_REQUEST handler with WS.INTERACTIVE_PROMPT handler. Replace WS.PERMISSION_DISMISSED handler with WS.PROMPT_DISMISSED handler.

- [ ] **Step 3:** Add respondPrompt callback that sends WS.PROMPT_RESPONSE and clears interactivePrompt state.

- [ ] **Step 4:** Update return object: replace permissionRequest with interactivePrompt, add respondPrompt. Keep respondPermission and respondAsk temporarily for any remaining direct callers.

- [ ] **Step 5:** Commit

---

### Task 8: ChatView + ReviewTab -- use InteractivePromptOverlay

**Files:**
- Modify: src/components/ChatView.tsx
- Modify: src/components/FloatingReviewPanel.tsx

- [ ] **Step 1:** ChatView: replace PermissionOverlay/AskQuestion with InteractivePromptOverlay. Update useChat destructuring (interactivePrompt, respondPrompt).

- [ ] **Step 2:** ReviewTab: destructure interactivePrompt + respondPrompt from useChat. Render InteractivePromptOverlay after ChatBody.

- [ ] **Step 3:** Commit

---

### Task 9: Gemini _waitForReady -- remaining startup prompts

**Files:**
- Modify: server/adapters/gemini/gemini-tmux-adapter.ts

- [ ] **Step 1:** Add detection in _waitForReady for:
  - Privacy Notice / Terms of Service: dismiss with Esc
  - Multi-folder trust: accept default with Enter
  - IDE integration nudge: decline (Down + Enter)

  All before hasPrompt check, after existing folder trust check.

- [ ] **Step 2:** Commit

---

### Task 10: Build + E2E

- [ ] **Step 1:** TypeScript check
- [ ] **Step 2:** Build
- [ ] **Step 3:** E2E: Gemini tool confirmation (default mode)
- [ ] **Step 4:** E2E: Gemini AskUser
- [ ] **Step 5:** E2E: Codex command approval (suggest mode)
- [ ] **Step 6:** E2E: Claude permissions (backwards compatible)
- [ ] **Step 7:** E2E: Multi-tab dismiss
