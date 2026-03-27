# Adapter Identity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix sessions opening with wrong adapter by deferring initialization until adapter is confirmed (from prop/URL or server SESSION_CREATED).

**Architecture:** Stop guessing adapter from localStorage. If adapter is known (session list click, URL with adapter param), initialize immediately. If unknown (bare URL, push notification), show loading until server tells us via SESSION_CREATED. Server is single source of truth.

**Tech Stack:** React, TypeScript, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-26-adapter-identity-fix-design.md`

---

## File Map

| File | Action | Change |
|---|---|---|
| `src/hooks/useChat.ts` | Modify | Defer init when adapter unknown, handle SESSION_CREATED fully |
| `src/App.tsx` | Modify | URL includes adapter, URL parser reads adapter |
| `src/components/ChatView.tsx` | Modify | Loading state when adapter unknown |
| `server/session-manager.ts` | Modify | SESSION_CREATED includes cwd, handleQuery verifies adapter |
| `src/components/SessionsView.tsx` | Modify | Active sessions badge |
| `src/sw.ts` | Modify | Notification URL includes adapter |

---

### Task 1: useChat — defer initialization when adapter unknown

**Files:**
- Modify: `src/hooks/useChat.ts:114-127` (init), `src/hooks/useChat.ts:169-174` (SESSION_CREATED handler)

- [ ] **Step 1: Change selectedAdapter to nullable, defer prefs init**

Replace lines 114-127:

```typescript
// Current:
const resolvedAdapter = initialAdapter || localStorage.getItem(STORAGE.ADAPTER) || 'claude';
const initialPrefs = loadAdapterPrefs(resolvedAdapter);
const [model, setModel] = useState<string>(initialPrefs.model || '');
const [permissionMode, setPermissionMode] = useState<string>(initialPrefs.permissionMode || 'default');
const [effort, setEffort] = useState<string>(initialPrefs.effort || 'high');
// ...
const [selectedAdapter, setSelectedAdapter] = useState<string>(resolvedAdapter);
```

With:

```typescript
// If adapter is known (from prop or URL), use it immediately.
// If unknown (bare URL, push notification), null → wait for server SESSION_CREATED.
const knownAdapter = initialAdapter || null;
const initialPrefs = knownAdapter ? loadAdapterPrefs(knownAdapter) : null;

const [model, setModel] = useState<string>(initialPrefs?.model || '');
const [permissionMode, setPermissionMode] = useState<string>(initialPrefs?.permissionMode || 'default');
const [effort, setEffort] = useState<string>(initialPrefs?.effort || '');
// ...
const [selectedAdapter, setSelectedAdapter] = useState<string | null>(knownAdapter);
```

**Important:** `selectedAdapter` is now `string | null`. When null, it means "waiting for server to tell us."

- [ ] **Step 2: Update SESSION_CREATED handler to fully initialize**

Replace lines 169-174:

```typescript
case WS.SESSION_CREATED:
  setSessionId(msg.sessionId);
  if (msg.adapter) {
    setSelectedAdapter(msg.adapter);
    // Load correct prefs now that we know the adapter
    const prefs = loadAdapterPrefs(msg.adapter);
    if (!knownAdapter) {
      // First time learning adapter — initialize prefs from scratch
      setModel(prefs.model || '');
      setPermissionMode(msg.permissionMode || prefs.permissionMode || 'default');
      setEffort(prefs.effort || '');
    } else {
      // Adapter was already known — just update permissionMode if server provides it
      if (msg.permissionMode) setPermissionMode(msg.permissionMode);
    }
  } else {
    if (msg.permissionMode) setPermissionMode(msg.permissionMode);
  }
  break;
```

- [ ] **Step 3: Fix all null-safety issues in useChat.ts**

`selectedAdapter` is now `string | null`. Every usage must be guarded:

| Line | Code | Fix |
|---|---|---|
| 149 | `useRef<string>(selectedAdapter)` | → `useRef<string \| null>(selectedAdapter)` |
| 363 | `patchAdapterPrefs(selectedAdapterRef.current, ...)` | → `if (selectedAdapterRef.current) patchAdapterPrefs(...)` |
| 408 | `client.setActiveSession(initialSessionId, selectedAdapter)` | → `client.setActiveSession(initialSessionId, selectedAdapter ?? undefined)` |
| 430 | `wsRef.current.setActiveSession(sessionId, selectedAdapter)` | → `wsRef.current.setActiveSession(sessionId, selectedAdapter ?? undefined)` |
| 436 | `api.adapterConfig(selectedAdapter)` | → `if (selectedAdapter) api.adapterConfig(selectedAdapter)...` |
| 455 | `adapter: selectedAdapter` in actualSend | → add `if (!selectedAdapter) return` at top of actualSend |
| 532 | `patchAdapterPrefs(selectedAdapter, { model })` | → `if (selectedAdapter) patchAdapterPrefs(...)` |
| 549 | `patchAdapterPrefs(selectedAdapter, { permissionMode })` | → `if (selectedAdapter) patchAdapterPrefs(...)` |

- [ ] **Step 4: Fix effort default — keep 'high' not empty string**

Change from the plan's `initialPrefs?.effort || ''` to:
```typescript
const [effort, setEffort] = useState<string>(initialPrefs?.effort || 'high');
```
Empty string effort causes blank label in NewChatView and omits `--effort` flag in CLI.

- [ ] **Step 5: Fix ws.ts — accept null adapter**

`src/lib/ws.ts:72` — `setActiveSession(sessionId, adapter?: string)` cannot accept `null`. Change to:
```typescript
setActiveSession(sessionId: string | null, adapter?: string | null) {
  this.activeSessionId = sessionId;
  this.activeAdapter = adapter || null;
}
```

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: Zero errors in useChat.ts and ws.ts

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useChat.ts src/lib/ws.ts
git commit -m "refactor: defer useChat init when adapter unknown — wait for server SESSION_CREATED"
```

---

### Task 2: App.tsx — URL includes adapter, parser reads it

**Files:**
- Modify: `src/App.tsx:39-47` (navigateTo), `src/App.tsx:202-217` (URL parser), `src/App.tsx:191-200` (push notification handler)

- [ ] **Step 1: navigateTo includes adapter in URL**

Replace lines 39-47:

```typescript
function navigateTo(view: View) {
  persistView(view);
  let url = '/';
  if (view.name === 'chat' && view.sessionId) {
    url = `/?view=chat&session=${view.sessionId}`;
    if (view.adapter) url += `&adapter=${view.adapter}`;
  } else if (view.name === 'settings') {
    url = '/?view=settings';
  }
  window.history.pushState({ view }, '', url);
}
```

- [ ] **Step 2: URL parser reads adapter from URL**

Replace lines 202-217:

```typescript
useEffect(() => {
  if (urlParamsHandled.current || !authed) return;
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');
  const adapter = params.get('adapter');
  const action = params.get('action');
  if (sessionId) {
    urlParamsHandled.current = true;
    openChat(sessionId, undefined, adapter || undefined);
    window.history.replaceState({}, '', '/');
  } else if (action === 'newchat') {
    urlParamsHandled.current = true;
    window.history.replaceState({}, '', '/');
  }
}, [authed, openChat]);
```

- [ ] **Step 3: Push notification handler — no change needed**

The push notification handler calls `openChat(sessionId)` with no adapter. This is correct — adapter is unknown, useChat will show loading and wait for SESSION_CREATED. The service worker's fallback URL `/?session=${sessionId}` also works (URL parser handles it, adapter will be null → loading → server resolves).

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: URL includes adapter param, parser reads it for instant adapter resolution"
```

---

### Task 3: ChatView — loading state when adapter unknown

**Files:**
- Modify: `src/components/ChatView.tsx:141-149` (useChat destructuring), add loading check before render

- [ ] **Step 1: Add loading state when selectedAdapter is null**

After the useChat destructuring (line ~149), before the return JSX (line ~487), add:

```typescript
// Waiting for server to tell us the adapter
if (!selectedAdapter) {
  return (
    <div className="flex flex-col h-dvh bg-bg items-center justify-center">
      <LoadingAnimation size="md" label="Connecting..." />
    </div>
  );
}
```

Import `LoadingAnimation` at the top of the file:
```typescript
import { LoadingAnimation } from './ui/LoadingAnimation';
```

- [ ] **Step 2: Fix ChatView null-safety**

The early return `if (!selectedAdapter)` guarantees all JSX below only runs when `selectedAdapter` is a string. TypeScript narrows it automatically. But verify:

- Line 169: `.filter(a => a !== selectedAdapter)` — safe after guard (narrowed to string)
- Line 440: `<StatusBar selectedAdapter={selectedAdapter}>` — safe (narrowed)
- All `getBrand(selectedAdapter)` calls — safe

**StatusBar.tsx** prop type `selectedAdapter: string` does NOT need to change — it's only rendered after the null guard in ChatView.

**Important**: Any code that runs BEFORE the null guard (e.g., useCallback hooks, useEffect hooks) must guard independently. Check:
- `closeReview` callback — uses `activeReviews`, not `selectedAdapter` → safe
- `openReview` callback — uses `reviewMenuMessageId` → safe
- `handleSendTo` — uses `activeReviews.length` → safe

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatView.tsx
git commit -m "feat: ChatView shows loading when adapter unknown, waits for server"
```

---

### Task 4: Server — SESSION_CREATED includes cwd

**Files:**
- Modify: `server/session-manager.ts:249-261` (sendSessionCreated)

- [ ] **Step 1: Add cwd to SESSION_CREATED payload**

The `sendSessionCreated` function currently sends `sessionId`, `adapter`, `permissionMode`. Add `cwd`:

```typescript
function sendSessionCreated(conn: ClientConnection, adapter: IAdapter, sessionId: string): void {
  const sessionObj = adapter.getSession(sessionId) as {
    permissionMode?: string;
    approvalPolicy?: string;
    cwd?: string;
  } | null;
  const adapterName = sessionAdapterMap.get(sessionId) || sessionAdapters.get(sessionId);
  send(conn, {
    type: WS.SESSION_CREATED,
    sessionId,
    adapter: adapterName,
    cwd: sessionObj?.cwd,
    permissionMode: sessionObj?.permissionMode || sessionObj?.approvalPolicy,
  });
}
```

Note: for historical (non-active) sessions, `adapter.getSession(sessionId)` returns null, so `cwd` will be undefined. This is acceptable — the header will show "Session" instead of project name, which is better than showing the wrong project.

- [ ] **Step 2: Commit**

```bash
git add server/session-manager.ts
git commit -m "feat: SESSION_CREATED includes cwd for project name display"
```

---

### Task 5: Server — handleQuery verifies adapter on resumeSession

**Files:**
- Modify: `server/session-manager.ts:293-307` (handleQuery)

- [ ] **Step 1: Verify adapter before resumeSession**

Replace lines 298-305:

```typescript
let handle: { sessionId: string };
if (sessionId) {
  // Verify adapter — don't trust client blindly
  const resolvedName = await resolveAdapterForSession(sessionId);
  const actualAdapter = resolvedName ? getAdapter(resolvedName) : adapter;
  const actualName = resolvedName || adapterName || DEFAULT_ADAPTER;
  handle = await actualAdapter!.resumeSession(sessionId, cwd as string, { permissionMode });
  registerSessionAdapter(handle.sessionId, actualName);
} else {
  handle = await adapter.startSession(cwd || process.cwd(), { model, permissionMode });
  registerSessionAdapter(handle.sessionId, adapterName || DEFAULT_ADAPTER);
}
registerClient(conn, handle.sessionId);
sendSessionCreated(conn, getAdapter(sessionAdapterMap.get(handle.sessionId) || DEFAULT_ADAPTER)!, handle.sessionId);
```

- [ ] **Step 2: Commit**

```bash
git add server/session-manager.ts
git commit -m "fix: handleQuery verifies adapter on resumeSession — don't trust client blindly"
```

---

### Task 6: Active sessions tab — add adapter badge

**Files:**
- Modify: `src/components/SessionsView.tsx:337-341` (active session card rendering)

- [ ] **Step 1: Add adapter badge to active session cards**

At line ~338, before the firstPrompt text, add the adapter badge:

```typescript
<span className="text-sm text-text truncate flex-1 mr-3">
  <span className="inline-block w-2 h-2 rounded-full bg-success mr-1.5 shrink-0" />
  {session.adapter && (() => {
    const brand = getBrand(session.adapter);
    return (
      <span
        className="text-[10px] font-semibold px-1.5 rounded shrink-0 mr-1"
        style={{ color: brand.color, backgroundColor: `${brand.color}20` }}
      >
        {brand.displayName}
      </span>
    );
  })()}
  {session.firstPrompt || session.sessionId}
</span>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SessionsView.tsx
git commit -m "feat: active sessions tab shows adapter badge"
```

---

### Task 7: Build + E2E Verification

- [ ] **Step 1: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | head -10`
Expected: Zero errors

- [ ] **Step 2: Build**

Run: `npm run build 2>&1 | tail -3`
Expected: Clean build

- [ ] **Step 3: E2E — Session list → Gemini historical session**

1. Restart server
2. Open browser, login
3. Navigate to code-tap project → click a Gemini session
4. Verify: Gemini badge in status bar, correct model, messages loaded

- [ ] **Step 4: E2E — Direct URL without adapter**

1. Open `http://localhost:3456/?view=chat&session=<gemini-session-id>`
2. Verify: Loading shown briefly → then correct Gemini adapter + messages

- [ ] **Step 5: E2E — Direct URL with adapter**

1. Open `http://localhost:3456/?view=chat&session=<id>&adapter=gemini`
2. Verify: No loading flash, immediately shows Gemini + messages

- [ ] **Step 6: E2E — Browser refresh on chat page**

1. While viewing a Gemini session, press F5
2. Verify: URL has `&adapter=gemini` → instant load, no flash

- [ ] **Step 7: E2E — Multi-tab sync**

1. Open same Gemini session in two tabs (via session list)
2. Send message from Tab 1
3. Verify Tab 2: user message appears → thinking indicator → response

- [ ] **Step 8: E2E — Active sessions tab**

1. Go to Active tab
2. Verify: each session shows adapter badge (Claude/Codex/Gemini)

- [ ] **Step 9: Final commit + push**

```bash
git push origin main
```
