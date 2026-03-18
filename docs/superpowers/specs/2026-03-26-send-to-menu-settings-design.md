# Send-to Menu Redesign + Settings Page

## Overview

Redesign the "Send to Other AI" menu for cross-AI review, add a Settings page for managing preferences and saved instructions.

Three deliverables:
1. **Send-to Menu** — Two-step bottom sheet with adapter selection, model picker, Direct Send / With Instructions
2. **Settings Page** — Centralized preferences: saved instructions, per-adapter defaults, notifications, about
3. **Saved Instructions DB** — Server-side storage for reusable instruction templates

## Part 1: Send-to Menu

### Layout: Two-Step Bottom Sheet

**Step 1 — Adapter Selection:**
- Bottom sheet titled "Send to…"
- Lists all available adapters (excluding current)
- Each row: adapter icon (official SVG from AdapterIcon.tsx) + adapter name
- No model shown here (model is selected in step 2)
- Tap row → navigates to step 2

**Step 2 — Action Selection:**
- Header: `‹ {AdapterName}` (back arrow + colored adapter name)
- Model dropdown: `Model: [gpt-5.4 ▾]` — uses native `<select>`, options from `GET /api/adapter/:name/config`
- Two action buttons:
  - **Direct Send** — icon ↗, subtitle "直接送出，不加 instructions"
  - **With Instructions** — icon ✎, subtitle "自訂或使用已儲存的", has ▼/▲ chevron for expand/collapse

**With Instructions (expandable section):**
- Saved instructions list (from DB) — tap to select and send immediately
- Divider: "或輸入新的"
- Text input + send button
- Tapping ▼/▲ toggles the section open/closed

### Behavior

**Direct Send:**
- Sends ONLY the raw response text (the message the user clicked ↗ on)
- No context wrapper, no conversation history, no instructions
- Immediately opens FloatingReviewPanel

**With Instructions (saved):**
- Sends: `{instruction}\n\n{response_text}`
- Immediately opens FloatingReviewPanel

**With Instructions (new):**
- Same format as saved
- After sending, show a toast at bottom: "存成常用？" + [Save] button
- Toast auto-dismisses after 3 seconds
- Tapping Save → `POST /api/instructions` with auto-generated label (first 30 chars of instruction)
- Saved instructions then appear in the list for future use

### Components Changed

| Component | Change |
|-----------|--------|
| `ReviewActionMenu.tsx` | Complete rewrite — two-step bottom sheet |
| `MessageBubble.tsx` / `SendDropdown` | Unchanged (still triggers `onSendTo`) |
| `ChatView.tsx` `handleReviewSelect` | Simplify — remove promptTemplates, context assembly. Direct Send = raw text, Instructions = instruction + raw text |
| `AdapterIcon.tsx` | Unchanged (already uses official SVGs) |

## Part 2: Settings Page

### Entry Point

- New ⚙️ icon button in the project list header (next to Logout)
- Navigates to Settings view

### Settings Structure

```
Settings
├── Saved Instructions
│   └── List with Add/Delete, tap to edit
├── Claude (per-adapter)
│   ├── Model: [dropdown]
│   ├── Permission Mode: [dropdown] (label from adapter)
│   └── Thinking: [dropdown] (label from adapter, "Thinking" for Claude)
├── Codex (per-adapter)
│   ├── Model: [dropdown]
│   ├── Permission Mode: [dropdown]
│   └── Effort: [dropdown] (label from adapter, "Effort" for Codex)
├── Notifications
│   └── Push Notifications: [toggle]
└── About
    └── CodeTap v{version}
```

### Per-Adapter Settings

- Options fetched dynamically from `GET /api/adapter/:name/config`
- Each adapter has its own models, permission modes, effort levels, and effort label
- Changes saved to `localStorage` via existing `adapter-prefs.ts` (same as current cycle buttons)
- NewChat page cycle buttons remain as shortcuts

### Saved Instructions Sub-page

```
‹ Saved Instructions              [+ Add]
──────────────────────────────────────────
  Code Review                          ✕
  Review for correctness, edge cases…

  Suggest Alternatives                 ✕
  Suggest 3 alternative approaches…
```

- `+ Add` → inline input or modal to enter label + instruction text
- `✕` → delete with confirmation
- v1: no edit — delete and recreate

### Version Number

- Read from `/api/health` endpoint (already returns version from `package.json`)

### Components

| Component | Type |
|-----------|------|
| `SettingsView.tsx` | New — main settings page |
| `SavedInstructionsView.tsx` | New — instruction management sub-page |
| `AdapterSettingsSection.tsx` | New — per-adapter dropdown settings |
| `SessionsView.tsx` | Modified — add ⚙️ icon in header |

## Part 3: Saved Instructions DB

### Schema

```sql
CREATE TABLE saved_instructions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  instruction TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### API Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/instructions` | — | List all, ordered by created_at |
| POST | `/api/instructions` | `{label, instruction}` | Create new |
| DELETE | `/api/instructions/:id` | — | Delete |

No update endpoint — delete and recreate. Keeps it simple.

### Client API

Add to `src/lib/api.ts`:
- `api.getInstructions(): Promise<Instruction[]>`
- `api.createInstruction(label, instruction): Promise<Instruction>`
- `api.deleteInstruction(id): Promise<void>`

## Data Flow Summary

```
User clicks ↗ on message
  → ReviewActionMenu opens (Step 1: pick adapter)
  → Step 2: pick model + Direct Send or With Instructions
  → Direct Send: sendMessage(rawText) to child adapter
  → With Instructions: sendMessage(instruction + rawText) to child adapter
  → FloatingReviewPanel opens (same as current QUERY path)
  → If new instruction used, toast offers to save
```

## Out of Scope

- Instruction editing (v1: delete + recreate)
- Instruction reordering (v1: created_at order)
- Per-adapter instructions (v1: global list)
- Theme/appearance settings
- Server-side config management
