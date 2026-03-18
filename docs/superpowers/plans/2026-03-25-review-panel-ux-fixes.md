# Review Panel UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Cross-AI Review UX issues: marker leaks, panel minimize/expand, send-back button, icon polish, read-only history, adapter icons.

**Spec:** `docs/superpowers/specs/2026-03-25-review-panel-ux-fixes-design.md`

---

### Task 1: Fix marker bugs (Session List + trailing `\\n`)

**Files:**
- `server/adapters/codex/codex-tmux-adapter.ts`
- `src/lib/content-utils.ts`

- [ ] **Step 1: Fix `stripMarker` regex to handle literal `\\n`**

In `src/lib/content-utils.ts` line 5, change:
```typescript
const CODETAP_REF_REGEX = /^\[CODETAP_REF:[^\]]+\]\n?/;
```
To:
```typescript
const CODETAP_REF_REGEX = /^\[CODETAP_REF:[^\]]+\](?:\\n|\n)?/;
```

This matches both real newline (`\n`) and literal two-char `\\n` (which Codex sendMessage produces).

- [ ] **Step 2: Strip marker from `firstPrompt` in Codex adapter**

In `server/adapters/codex/codex-tmux-adapter.ts` around line 445, after extracting text:
```typescript
if (text) session.firstPrompt = text.substring(0, 200);
```

Change to:
```typescript
if (text) {
  // Strip CODETAP_REF marker if present
  const stripped = text.replace(/^\[CODETAP_REF:[^\]]+\](?:\\n|\n)?/, '');
  session.firstPrompt = stripped.substring(0, 200);
}
```

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit
git add src/lib/content-utils.ts server/adapters/codex/codex-tmux-adapter.ts
git commit -m "fix: strip CODETAP_REF marker from session list + handle literal \\n"
```

---

### Task 2: Fix send-back button + icon polish + copy feedback

**Files:**
- `src/components/ChatBody.tsx`
- `src/components/MessageBubble.tsx`

- [ ] **Step 1: Fix `showActions` to include `onSendBack` (ChatBody.tsx line 199)**

**ROOT CAUSE:** `showActions` requires `sendTargets` but FloatingReviewPanel only passes `onSendBack`.

Change line 199 from:
```typescript
showActions={msg.role === 'assistant' && !streaming && !!sendTargets && sendTargets.length > 0}
```
To:
```typescript
showActions={msg.role === 'assistant' && !streaming && (!!onSendBack || (!!sendTargets && sendTargets.length > 0))}
```

- [ ] **Step 2: Remove border from icon buttons (MessageBubble.tsx lines 186-210)**

Change copy button className (line 188) from:
```
"flex items-center justify-center w-7 h-7 text-text-dim border border-border rounded-md hover:bg-white/5 transition-colors"
```
To:
```
"flex items-center justify-center w-6 h-6 text-text-dim/40 hover:text-text-dim hover:bg-white/5 rounded transition-colors"
```

Change send-back button className (line 196) from:
```
"flex items-center justify-center w-7 h-7 text-green-400 border border-green-400/30 rounded-md hover:bg-green-400/10 transition-colors"
```
To:
```
"flex items-center justify-center w-6 h-6 text-green-400/40 hover:text-green-400 hover:bg-green-400/10 rounded transition-colors"
```

Apply similar change to the SendDropdown button if it has border.

- [ ] **Step 3: Reduce icon size and stroke width (MessageBubble.tsx lines 34-59)**

In all three icon components (CopyIcon, SendIcon, SendBackIcon), change:
```
width="14" height="14" ... strokeWidth="2"
```
To:
```
width="12" height="12" ... strokeWidth="1.5"
```

- [ ] **Step 4: Add copy feedback — checkmark confirmation**

Add `useState` import. Add state inside `MessageBubble`:
```typescript
const [copied, setCopied] = useState(false);
```

Change the copy button onClick (line 187):
```typescript
onClick={() => {
  navigator.clipboard.writeText(extractTextFromBlocks(content));
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
}}
```

Change the copy button icon rendering:
```tsx
{copied ? <CheckIcon /> : <CopyIcon />}
```

Add CheckIcon component:
```typescript
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
```

When `copied` is true, change button color to green briefly:
```typescript
className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${
  copied ? 'text-green-400' : 'text-text-dim/40 hover:text-text-dim hover:bg-white/5'
}`}
```

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit
git add src/components/ChatBody.tsx src/components/MessageBubble.tsx
git commit -m "fix: send-back button visible, icon polish (no border, smaller), copy checkmark feedback"
```

---

### Task 3: Panel minimize — thin bar above input

**Files:**
- `src/components/FloatingReviewPanel.tsx`
- `src/components/ChatBody.tsx` (placeholder prop)

- [ ] **Step 1: Minimized bar rendered by ChatView (NOT FloatingReviewPanel)**

The minimized bar must sit between the message scroll area and the input — in the normal document flow. FloatingReviewPanel can't do this because it renders as an overlay. Solution: ChatView renders the bar directly. FloatingReviewPanel returns `null` when `panelState === 'minimized'`.

In FloatingReviewPanel, change the minimized block (lines 57-67) to:
```tsx
if (panelState === 'minimized') return null;
```

In ChatView, add a `ReviewMinimizedBar` inline component (or extract to a small file). Render it between ChatBody and the footer, using `renderAboveInput` slot on ChatBody:

```tsx
// In ChatView's renderAboveInput callback:
renderAboveInput={() => (
  <>
    {activeReview && reviewPanelState === 'minimized' && (
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: `${getBrand(activeReview.childAdapter).color}08`, borderTop: `1px solid ${getBrand(activeReview.childAdapter).color}25` }}
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: getBrand(activeReview.childAdapter).color }} />
          <span className="text-[10px] font-semibold" style={{ color: getBrand(activeReview.childAdapter).color }}>
            {getBrand(activeReview.childAdapter).displayName}
          </span>
          <span className="text-[10px] text-text-dim/50">{activeReview.reviewTitle || 'review'} · active</span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setReviewPanelState('expanded')} className="text-[10px] transition-colors" style={{ color: `${getBrand(activeReview.childAdapter).color}80` }}>
            ▲ Expand
          </button>
          <button onClick={handleEndReview} className="text-[10px] text-red-400/80 hover:text-red-400 transition-colors">
            End
          </button>
        </div>
      </div>
    )}
    <StatusBar ... />
  </>
)}
```

Note: no message count shown — parent doesn't have access to child message count. Show "active" instead.

- [ ] **Step 2: Add ▼ Minimize button to expanded panel header (lines 98-113)**

In the expanded panel header, add a minimize button next to End:

```tsx
<button
  onClick={() => onPanelStateChange('minimized')}
  className="text-xs text-text-dim/50 hover:text-text-dim px-2 py-1 rounded hover:bg-white/5 transition-colors"
>▼</button>
```

- [ ] **Step 3: Update child input placeholder**

In FloatingReviewPanel, pass a custom placeholder to ChatBody. Add `inputPlaceholder` prop to ChatBody:

```typescript
// ChatBody props
inputPlaceholder?: string;
```

In ChatBody, pass to ShimmerInput:
```tsx
<ShimmerInput placeholder={inputPlaceholder || "Send a message..."} ... />
```

FloatingReviewPanel passes:
```tsx
inputPlaceholder={`Reply to ${brand.displayName} review...`}
```

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit
git add src/components/FloatingReviewPanel.tsx src/components/ChatView.tsx src/components/ChatBody.tsx
git commit -m "feat: review panel minimizes to thin bar above input, custom placeholder"
```

---

### Task 4: CollapsedReviewCard onClick + read-only panel

**Files:**
- `src/components/CollapsedReviewCard.tsx`
- `src/components/ChatView.tsx`
- `src/components/FloatingReviewPanel.tsx`

- [ ] **Step 1: Pass `childSessionId` to CollapsedReviewCard**

In ChatView `renderReviewMarkers` (line 268), the review object has `child_cli_session_id`. Pass it:

```tsx
<CollapsedReviewCard
  adapter={review.child_adapter}
  title={review.review_title}
  messageCount={review.message_count || 0}
  summary="Tap to view review conversation"
  onClick={() => handleOpenReadOnlyReview(review)}
/>
```

Add handler in ChatView:
```typescript
const handleOpenReadOnlyReview = useCallback((review: any) => {
  setActiveReview({
    reviewId: review.id,
    childSessionId: review.child_cli_session_id,
    childCliSessionId: review.child_cli_session_id,
    childAdapter: review.child_adapter,
    anchorMessageId: review.anchor_message_id,
    reviewTitle: review.review_title,
  });
  setReviewPanelState('expanded');
  setReadOnlyReview(true);  // NEW state
}, []);
```

Add state:
```typescript
const [readOnlyReview, setReadOnlyReview] = useState(false);
```

- [ ] **Step 2: Add `readOnly` prop to FloatingReviewPanel**

```typescript
interface FloatingReviewPanelProps {
  // ... existing props
  readOnly?: boolean;
}
```

When `readOnly`:
- Header: gray instead of green, "ended" label, ✕ Close instead of End
- No ShimmerInput — show "Review ended — read only" text
- No send-back action

Pass to ChatBody:
```tsx
<ChatBody
  ...
  disabled={readOnly}
  onSendBack={readOnly ? undefined : handleSendBack}
/>
```

If readOnly, don't render ShimmerInput in ChatBody. Add a `hideInput` prop to ChatBody:
```typescript
hideInput?: boolean;
```

- [ ] **Step 3: Update onEnd for read-only panel**

FloatingReviewPanel uses the existing `onEnd` callback. The `readOnly` prop controls what the button says:
```tsx
<button onClick={onEnd}>
  {readOnly ? '✕' : 'End'}
</button>
```

In ChatView's `onEnd` handler, check `readOnlyReview`:
```tsx
onEnd={async () => {
  if (!readOnlyReview && activeReview.reviewId) {
    try { await api.endReview(activeReview.reviewId); } catch {}
  }
  setActiveReview(null);
  setReviewPanelState('hidden');
  setReviewInitialPrompt(null);
  setReviewCwd(null);
  setReadOnlyReview(false);
}}
```

Also reset `readOnlyReview` in `handleReviewSelect` (when opening a new active review):
```typescript
setReadOnlyReview(false);
```

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit
git add src/components/CollapsedReviewCard.tsx src/components/ChatView.tsx src/components/FloatingReviewPanel.tsx src/components/ChatBody.tsx
git commit -m "feat: collapsed review card opens read-only panel with child session history"
```

---

### Task 5: Adapter icons from thesvg.org

**Files:**
- `src/components/AdapterIcon.tsx`

- [ ] **Step 1: Fetch SVGs from thesvg.org**

Visit https://www.thesvg.org/ and search for:
- "Anthropic" or "Claude" → get the official Anthropic logo SVG
- "OpenAI" → get the official OpenAI logo SVG

- [ ] **Step 2: Update ClaudeIcon and CodexIcon**

Replace the SVG paths in `AdapterIcon.tsx` (lines 10-37) with the official ones from thesvg.org. Keep:
- `fill="currentColor"` for color control
- `viewBox` matching the original SVG
- `width={size} height={size}` props

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit
git add src/components/AdapterIcon.tsx
git commit -m "feat: use official adapter icons from thesvg.org"
```

---

### Task 6: E2E Verification

- [ ] **Step 1:** Start server, create Codex session → verify no marker in session list
- [ ] **Step 2:** Open Codex session → verify no `\\n` at start of first message
- [ ] **Step 3:** Create Claude session → send message → Click send icon → Direct send → verify panel opens with Codex response
- [ ] **Step 4:** Verify send-back ↩ icon appears on child responses
- [ ] **Step 5:** Verify copy icon → click → ✓ checkmark appears → reverts after 2s
- [ ] **Step 6:** Verify icon buttons have no border, smaller size
- [ ] **Step 7:** Click ▼ minimize → verify thin bar appears above input → parent input usable
- [ ] **Step 8:** Click ▲ Expand → panel opens again
- [ ] **Step 9:** Click End → verify panel closes → review markers appear in history
- [ ] **Step 10:** Click collapsed review card → verify read-only panel opens (no input, gray header)
- [ ] **Step 11:** Close read-only panel → verify return to normal chat

---

## Self-Review

### showActions bug fix
Before: `showActions = assistant && !streaming && !!sendTargets && sendTargets.length > 0`
After: `showActions = assistant && !streaming && (!!onSendBack || (!!sendTargets && sendTargets.length > 0))`
FloatingReviewPanel passes `onSendBack` but not `sendTargets` → now shows action buttons ✅

### Minimized bar placement
Renders as normal flow element (not absolute) between ChatBody and input. Parent chat is fully scrollable and input is fully usable. ✅

### Read-only panel
Uses same FloatingReviewPanel with `readOnly` flag. RECONNECT to child session for history. No input, no send-back. ✅

### Files changed
| File | Changes |
|------|---------|
| `src/lib/content-utils.ts` | Fix stripMarker regex |
| `server/adapters/codex/codex-tmux-adapter.ts` | Strip marker from firstPrompt |
| `src/components/ChatBody.tsx` | Fix showActions, add inputPlaceholder/hideInput |
| `src/components/MessageBubble.tsx` | Icon polish, copy feedback, no border |
| `src/components/FloatingReviewPanel.tsx` | Thin bar minimize, readOnly, custom placeholder |
| `src/components/ChatView.tsx` | Minimized bar, read-only review handler |
| `src/components/CollapsedReviewCard.tsx` | Pass onClick with review data |
| `src/components/AdapterIcon.tsx` | Official SVGs from thesvg.org |
