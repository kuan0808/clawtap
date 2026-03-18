# Send-to Menu Redesign + Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Send-to menu as a two-step bottom sheet with model selection, add a Settings page with saved instructions management and per-adapter preferences.

**Architecture:** Three layers of changes: (1) Server — new `saved_instructions` DB table + API endpoints, (2) Client API — new instruction CRUD methods, (3) UI — rewritten ReviewActionMenu, new SettingsView with sub-pages, updated App routing and SessionsView header.

**Tech Stack:** React + TypeScript + Vite (client), Express + SQLite + better-sqlite3 (server), Tailwind CSS (styling)

**Spec:** `docs/superpowers/specs/2026-03-26-send-to-menu-settings-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/db.ts` | Modify | Add `saved_instructions` table + prepared statements + `savedInstructions` operations |
| `server/index.ts` | Modify | Add 3 instruction API endpoints |
| `src/lib/api.ts` | Modify | Add instruction CRUD client methods |
| `src/components/ReviewActionMenu.tsx` | Rewrite | Two-step bottom sheet with adapter/model/instructions |
| `src/components/ChatView.tsx` | Modify | Simplify `handleReviewSelect` — no more context assembly |
| `src/App.tsx` | Modify | Add `settings` view to routing |
| `src/components/SessionsView.tsx` | Modify | Add settings icon in header |
| `src/components/SettingsView.tsx` | Create | Main settings page with sections |
| `src/components/SavedInstructionsView.tsx` | Create | Instruction list with add/delete |
| `src/components/AdapterSettingsSection.tsx` | Create | Per-adapter model/permission/effort dropdowns |

---

## Task 1: Saved Instructions — Server DB + API

**Files:**
- Modify: `server/db.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Add `saved_instructions` table to DB**

In `server/db.ts`, add to the `db.exec()` block (after `session_reviews` table):

```sql
CREATE TABLE IF NOT EXISTS saved_instructions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  instruction TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Add prepared statements**

In the `PreparedStatements` interface, add:
```typescript
instructionCreate: BetterSqlite3.Statement;
instructionGetAll: BetterSqlite3.Statement;
instructionDelete: BetterSqlite3.Statement;
```

In the `stmts()` function, add:
```typescript
instructionCreate: d.prepare(
  `INSERT INTO saved_instructions (id, label, instruction) VALUES (?, ?, ?)`
),
instructionGetAll: d.prepare(
  `SELECT * FROM saved_instructions ORDER BY created_at ASC`
),
instructionDelete: d.prepare(
  `DELETE FROM saved_instructions WHERE id = ?`
),
```

- [ ] **Step 3: Add `savedInstructions` export object**

After the `sessionReviews` export, add:
```typescript
export const savedInstructions = {
  create(id: string, label: string, instruction: string): void {
    stmts().instructionCreate.run(id, label, instruction);
  },
  getAll(): { id: string; label: string; instruction: string; created_at: string }[] {
    return stmts().instructionGetAll.all() as any[];
  },
  delete(id: string): void {
    stmts().instructionDelete.run(id);
  },
};
```

- [ ] **Step 4: Add API endpoints in `server/index.ts`**

Import `savedInstructions` from `./db.js`. Add 3 routes after the review routes:

```typescript
// --- Saved Instructions API ---

app.get('/api/instructions', authMiddleware, (_req: Request, res: Response) => {
  try {
    res.json(savedInstructions.getAll());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/instructions', authMiddleware, (req: Request, res: Response) => {
  try {
    const { label, instruction } = req.body;
    if (!label || !instruction) return res.status(400).json({ error: 'label and instruction required' });
    const id = randomUUID();
    savedInstructions.create(id, label, instruction);
    res.json({ id, label, instruction });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/instructions/:id', authMiddleware, (req: Request, res: Response) => {
  try {
    savedInstructions.delete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

Note: `randomUUID` is already imported in `server/index.ts`.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add server/db.ts server/index.ts
git commit -m "feat: add saved_instructions DB table and API endpoints"
```

---

## Task 2: Client API — Instruction Methods

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add instruction API methods**

Add to the `api` object, following the existing pattern (see `registerReview`, `endReview` for reference):

```typescript
async getInstructions(): Promise<{ id: string; label: string; instruction: string; created_at: string }[]> {
  return request('/api/instructions');
},

async createInstruction(label: string, instruction: string): Promise<{ id: string; label: string; instruction: string }> {
  return request('/api/instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, instruction }),
  });
},

async deleteInstruction(id: string): Promise<void> {
  return request(`/api/instructions/${id}`, { method: 'DELETE' });
},
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add instruction CRUD methods to client API"
```

---

## Task 3: ReviewActionMenu — Two-Step Bottom Sheet

**Files:**
- Rewrite: `src/components/ReviewActionMenu.tsx`

This is the core UI change. The component goes from a simple template picker to a two-step bottom sheet with adapter selection, model picker, and expandable instructions panel.

- [ ] **Step 1: Rewrite ReviewActionMenu.tsx**

New props interface:
```typescript
interface ReviewActionMenuProps {
  visible: boolean;
  adapters: { id: string; displayName: string }[];
  onDirectSend: (adapter: string, model: string) => void;
  onSendWithInstruction: (adapter: string, model: string, instruction: string, isCustom: boolean) => void;
  onClose: () => void;
}
```

Component state:
- `step`: `'adapter' | 'action'` — which step is shown
- `selectedAdapter`: `string | null` — chosen adapter ID
- `adapterConfig`: loaded from `api.adapterConfig(selectedAdapter)` when adapter is chosen
- `selectedModel`: `string` — from adapterConfig.models, default to first item
- `instructionsExpanded`: `boolean` — toggle for With Instructions section
- `savedInstructions`: loaded from `api.getInstructions()` on mount
- `customText`: `string` — free text input value

**Step 1 UI** (adapter selection):
- Backdrop overlay (click to close)
- Bottom sheet with drag handle
- "Send to…" title
- Adapter rows: `<AdapterIcon>` + adapter name, no model text, tap → set selectedAdapter + go to step 2

**Step 2 UI** (action selection):
- `‹ {AdapterName}` header with colored adapter name (back arrow returns to step 1)
- Model: `<select>` with options from `adapterConfig.models`
- "Direct Send" button (icon ↗) — calls `onDirectSend(selectedAdapter, selectedModel)` then `onClose()`
- "With Instructions" button (icon ✎) with ▼/▲ chevron — toggles `instructionsExpanded`
- When expanded:
  - Saved instructions list (tap → calls `onSendWithInstruction(adapter, model, item.instruction, false)`)
  - Divider "或輸入新的"
  - Text input + ↑ send button → calls `onSendWithInstruction(adapter, model, customText, true)` (isCustom=true triggers save toast)
  - Text input + ↑ send button → calls `onSendWithInstruction(adapter, model, customText)`

Use `AdapterIcon` component from `./AdapterIcon` for adapter icons.
Use `getBrand` from `@/lib/adapter-brands` for adapter colors.

Reset `step` to `'adapter'` whenever `visible` changes to true.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/ReviewActionMenu.tsx
git commit -m "feat: rewrite ReviewActionMenu as two-step bottom sheet"
```

---

## Task 4: ChatView — Simplify Review Flow + Save Toast

**Files:**
- Modify: `src/components/ChatView.tsx`

- [ ] **Step 1: Replace handleReviewSelect with two new handlers**

Delete the old `handleReviewSelect` callback, the `promptTemplates` record, and the context assembly code.

Add two new handlers:

```typescript
const handleDirectSend = useCallback((adapter: string, model: string) => {
  const anchorId = reviewMenuMessageId;
  setReviewMenuMessageId(null);
  setReviewTargetAdapter(null);
  if (!anchorId) return;

  // Save selected model to adapter prefs so child session uses it
  patchAdapterPrefs(adapter, { model });

  const anchorMsg = messages.find(m => m.id === anchorId);
  const rawText = anchorMsg ? extractTextFromBlocks(anchorMsg.content) : '';

  setHistoryReview(null);
  setActiveReview({
    reviewId: '', childSessionId: '', childCliSessionId: '',
    childAdapter: adapter, anchorMessageId: anchorId, reviewTitle: 'direct',
  });
  setReviewInitialPrompt(rawText);
  setReviewCwd(cwd || null);
  setActiveReviewPanel('expanded');
}, [reviewMenuMessageId, messages, cwd]);

const handleSendWithInstruction = useCallback((adapter: string, model: string, instruction: string, isCustom: boolean) => {
  const anchorId = reviewMenuMessageId;
  setReviewMenuMessageId(null);
  setReviewTargetAdapter(null);
  if (!anchorId) return;

  // Save selected model to adapter prefs so child session uses it
  patchAdapterPrefs(adapter, { model });

  const anchorMsg = messages.find(m => m.id === anchorId);
  const rawText = anchorMsg ? extractTextFromBlocks(anchorMsg.content) : '';
  const prompt = `${instruction}\n\n${rawText}`;
  const title = instruction.substring(0, 30);

  setHistoryReview(null);
  setActiveReview({
    reviewId: '', childSessionId: '', childCliSessionId: '',
    childAdapter: adapter, anchorMessageId: anchorId, reviewTitle: title,
  });
  setReviewInitialPrompt(prompt);
  setReviewCwd(cwd || null);
  setActiveReviewPanel('expanded');

  // Show save toast only for custom (typed) instructions, not saved ones
  if (isCustom) {
    setSaveToast({ instruction, label: title });
    setTimeout(() => setSaveToast(null), 3000);
  }
}, [reviewMenuMessageId, messages, cwd]);
```

Add state:
```typescript
const [saveToast, setSaveToast] = useState<{ instruction: string; label: string } | null>(null);
```

- [ ] **Step 2: Update ReviewActionMenu JSX**

Replace the current `<ReviewActionMenu>` with:
```tsx
<ReviewActionMenu
  visible={!!reviewMenuMessageId}
  adapters={sendTargets.map(t => ({ id: t.adapter, displayName: t.label }))}
  onDirectSend={handleDirectSend}
  onSendWithInstruction={handleSendWithInstruction}
  onClose={() => { setReviewMenuMessageId(null); setReviewTargetAdapter(null); }}
/>
```

- [ ] **Step 3: Add save toast UI**

Render at the bottom of the ChatView return, before the closing `</div>`:
```tsx
{saveToast && (
  <div className="fixed bottom-20 left-4 right-4 bg-[#1a1a1a] border border-[#333] rounded-xl p-3 flex items-center justify-between z-30">
    <span className="text-sm text-[#888]">存成常用？</span>
    <button
      className="text-sm text-blue-400 font-medium px-3 py-1 rounded-lg hover:bg-blue-400/10"
      onClick={() => {
        api.createInstruction(saveToast.label, saveToast.instruction);
        setSaveToast(null);
      }}
    >Save</button>
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatView.tsx
git commit -m "feat: simplify review flow — direct send raw text, instructions without context"
```

---

## Task 5: App Routing — Add Settings View

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add settings to View type and rendering**

Add `| { name: 'settings' }` to the `View` union type.

Add rendering branch before the default `SessionsView`:
```tsx
if (view.name === 'settings') {
  return <SettingsView onBack={() => setView({ name: 'sessions' })} />;
}
```

Add import: `import { SettingsView } from './components/SettingsView';`

- [ ] **Step 2: Pass onOpenSettings to SessionsView**

Add prop to the `<SessionsView>` JSX:
```tsx
onOpenSettings={() => setView({ name: 'settings' })}
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add settings view to app routing"
```

---

## Task 6: SessionsView — Settings Icon in Header

**Files:**
- Modify: `src/components/SessionsView.tsx`

- [ ] **Step 1: Add `onOpenSettings` prop and gear icon**

Add `onOpenSettings: () => void` to the component props.

In the header's button group (the `<div className="flex items-center gap-2">` block), add before the Logout button:
```tsx
<button
  onClick={onOpenSettings}
  className="p-2 text-text-dim hover:text-text transition-colors"
  title="Settings"
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
</button>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SessionsView.tsx
git commit -m "feat: add settings gear icon to project list header"
```

---

## Task 7: SettingsView — Main Settings Page

**Files:**
- Create: `src/components/SettingsView.tsx`

- [ ] **Step 1: Create SettingsView component**

Props: `onBack: () => void`

State:
- `subView`: `'main' | 'instructions' | string` (string = adapter id)
- `adapters`: fetched from `api.adapters()` on mount
- `version`: fetched from server health endpoint or read from a constant

Sub-view routing:
- `subView === 'instructions'` → render `<SavedInstructionsView onBack={() => setSubView('main')} />`
- `subView` matches an adapter id → render `<AdapterSettingsSection adapter={subView} onBack={() => setSubView('main')} />`
- Default → render main list

Main list: dark themed rows with chevrons, each tappable:
- "Saved Instructions" → `setSubView('instructions')`
- One row per adapter (icon + name) → `setSubView(adapterId)`
- "Notifications" → inline push toggle (reuse existing `usePushNotifications` hook)
- "About" → show `CodeTap v{version}` inline

Header: back arrow + "Settings" title, same style as existing headers.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsView.tsx
git commit -m "feat: create SettingsView with section navigation"
```

---

## Task 8: SavedInstructionsView — Instruction Management

**Files:**
- Create: `src/components/SavedInstructionsView.tsx`

- [ ] **Step 1: Create SavedInstructionsView component**

Props: `onBack: () => void`

State:
- `instructions`: array, fetched from `api.getInstructions()` on mount
- `showAddForm`: boolean
- `newLabel`: string
- `newInstruction`: string

UI:
- Header: back arrow + "Saved Instructions" + `[+ Add]` button
- List: each item shows label (bold) + instruction preview (truncated, dim) + ✕ delete button
- Delete: show `window.confirm('Delete this instruction?')`, then `api.deleteInstruction(id)`, remove from local state
- Add form (when showAddForm): label input + instruction textarea + [Save] + [Cancel] buttons
- Save: `api.createInstruction(label, instruction)`, append to local state, hide form

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/SavedInstructionsView.tsx
git commit -m "feat: create SavedInstructionsView with add/delete"
```

---

## Task 9: AdapterSettingsSection — Per-Adapter Preferences

**Files:**
- Create: `src/components/AdapterSettingsSection.tsx`

- [ ] **Step 1: Create AdapterSettingsSection component**

Props: `adapter: string; onBack: () => void`

State:
- `config`: fetched from `api.adapterConfig(adapter)` on mount (contains models, permissionModes, effortLevels, effortLabel)
- `prefs`: loaded from `loadAdapterPrefs(adapter)` (model, permissionMode, effort)

UI:
- Header: back arrow + AdapterIcon + adapter display name (from `getBrand`)
- Three `<select>` dropdowns, each with a label:
  - "Model" → options from `config.models` (each has `value` + `label`)
  - "Permission Mode" → options from `config.permissionModes`
  - Effort label from `config.effortLabel` (e.g. "Thinking" for Claude, "Effort" for Codex) → options from `config.effortLevels`
- On change: `patchAdapterPrefs(adapter, { [field]: value })` to persist to localStorage

Import `loadAdapterPrefs`, `patchAdapterPrefs` from `@/lib/adapter-prefs`.
Import `getBrand` from `@/lib/adapter-brands`.
Import `AdapterIcon` from `./AdapterIcon`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/AdapterSettingsSection.tsx
git commit -m "feat: create AdapterSettingsSection with per-adapter dropdowns"
```

---

## Task 10: E2E Verification

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Start server (without watch mode) and Vite**

Start server and Vite in separate processes. Ensure tmux session exists first.

- [ ] **Step 3: Visual verification in browser**

Verify the following scenarios:
1. Settings icon visible in project list header
2. Settings page loads with all sections
3. Saved Instructions: add an instruction, verify it appears in list, delete it
4. Adapter settings: all dropdowns populate with correct adapter-specific options
5. In a chat, click send icon → two-step menu opens
6. Step 1 shows adapter icons + names (no model text)
7. Step 2 shows model dropdown + Direct Send + With Instructions
8. With Instructions has expand/collapse chevron
9. Direct Send sends only raw response text
10. With Instructions sends instruction + raw text
11. Save toast appears and works after custom instruction send

- [ ] **Step 4: Final commit if any fixes needed**
