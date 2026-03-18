# Cross-AI Review Panel UX Fixes

## Context

E2E testing revealed several UX issues with Cross-AI Review: marker text leaking into UI, panel blocking parent interaction, and incomplete features (collapsed card onClick, read-only mode).

## Issues & Fixes

### A. Marker Bugs

**A1. Session List shows marker**
`firstPrompt` in Codex adapter extracts raw text from JSONL without stripping `[CODETAP_REF:xxx]`. Session list displays it.

Fix: Strip marker when setting `firstPrompt` in Codex adapter's `_processWatcherEntries`.

**A2. Marker trailing `\\n` residue**
`handleQuery` injects `[CODETAP_REF:xxx]\n{prompt}`. Codex `sendMessage` replaces `\n` → `\\n`. JSONL stores `[CODETAP_REF:xxx]\\nHello`. `stripMarker` regex `\n?` matches real newline but not literal `\\n`.

Fix: Update `stripMarker` regex to `^\[CODETAP_REF:[^\]]+\](?:\\\\n|\n)?` — matches both real newline and literal `\\n`.

**Files:** `server/adapters/codex/codex-tmux-adapter.ts`, `src/lib/content-utils.ts`

### B. Panel Minimize / Expand UX

**B1. Minimized state: thin bar above input**
When minimized, show a full-width bar between the message area and parent input:
- Left: pulsing green dot + adapter badge ("Codex") + status ("review in progress · 3 messages")
- Right: ▲ Expand button + End button
- Bar has subtle green top border

**B2. Expanded state: clear minimize button**
Panel header gets a ▼ Minimize icon button (in addition to handle bar). Header shows: adapter badge + review title + ▼ Minimize + End.

**B3. Input distinction**
When panel is expanded, the child input shows:
- Adapter badge (small Codex icon) to the left of the input
- Placeholder: "Reply to Codex review..." (not generic "Send a message...")
- Panel has green top border separating it from parent chat

**B4. Panel covers parent input**
When expanded, parent input is hidden (covered by panel). Only child input visible. This is intentional — user must minimize to chat with parent.

**Files:** `src/components/FloatingReviewPanel.tsx`, `src/components/ChatBody.tsx` (placeholder prop)

### C. Review History Markers

**C1. Start/End markers wrap all content**
Review Start and End markers appear in parent chat history. Everything between them (including parent messages exchanged while review was minimized) is wrapped. This shows "review was happening during this time period."

```
[parent message]
──── Codex review started ────
[collapsed review card: "5 messages · tap to view"]
[parent message during review]
[parent message during review]
──── Codex review ended ────
[parent message after review]
```

**C2. CollapsedReviewCard onClick → read-only panel**
Currently onClick is a TODO. Implement: clicking opens FloatingReviewPanel in read-only mode with child session's history via RECONNECT.

Card receives `childSessionId` from the review record. Click sets a `readOnlyReview` state in ChatView → mounts FloatingReviewPanel with `readOnly` flag.

**C3. Read-only panel**
Same layout as active panel but:
- Gray header (not green) — "Codex | code review · ended"
- ✕ Close button (not End)
- No input — bottom shows "Review ended — read only"
- Messages loaded via RECONNECT + HISTORY_LOAD

**Files:** `src/components/CollapsedReviewCard.tsx`, `src/components/ChatView.tsx`, `src/components/FloatingReviewPanel.tsx`

### D. Send-back Button Missing in Child Panel

**Problem:** Child session's assistant responses should show a ↩ send-back icon, but it's not visible. After the ChatBody refactor, `onSendBack` is passed from FloatingReviewPanel → ChatBody → MessageBubble. But `showActions` may not be correctly evaluated, or the prop chain is broken.

**Fix:** Verify and fix the prop chain:
1. FloatingReviewPanel passes `onSendBack` to ChatBody ✓ (confirmed in code)
2. ChatBody passes `onSendBack` to MessageBubble — check `showActions` logic
3. MessageBubble renders ↩ icon when `onSendBack` is provided and `showActions` is true

If `showActions` is computed inside ChatBody (not passed as prop), verify it evaluates to `true` for assistant messages when not streaming.

**Files:** `src/components/ChatBody.tsx`, `src/components/MessageBubble.tsx`

### E. Message Action Icons Polish

**E1. Icons too large / too bold / have border**
Current icon buttons have `border border-border rounded-md` (visible outline box), `w-7 h-7` (28px), and SVG `strokeWidth="2"`.

Fix:
- Remove `border` from button — no outline box, just the icon
- Reduce button size from `w-7 h-7` to `w-6 h-6` (24px)
- Reduce SVG from `width/height="14"` to `"12"`
- Reduce SVG `strokeWidth` from `"2"` to `"1.5"`
- Keep hover background (`hover:bg-white/5`) for touch feedback

**E2. Copy feedback — checkmark confirmation**
Copy icon should show a ✓ checkmark for ~2 seconds after clicking, then revert to the copy icon. Confirms the clipboard action succeeded.

Implementation: `useState` for `copied` state, `setTimeout` to reset after 2s.

**Files:** `src/components/MessageBubble.tsx`

### F. Adapter Icons — Use SVGs from thesvg.org

Current `AdapterIcon.tsx` has hand-drawn SVG paths for Claude (Anthropic "A") and Codex (OpenAI knot). Replace with official SVGs from https://www.thesvg.org/ for better accuracy.

- Search for "Anthropic" / "Claude" → get official Anthropic logo SVG
- Search for "OpenAI" / "Codex" → get official OpenAI logo SVG
- Update `ClaudeIcon` and `CodexIcon` components in `src/components/AdapterIcon.tsx`
- Keep the same `size` prop interface and `fill="currentColor"` for color control

**Files:** `src/components/AdapterIcon.tsx`

## Not Changed
- Review session creation flow (already unified via QUERY in previous spec)
- Server-side review lifecycle
