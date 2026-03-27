# Adapter Identity Fix — Design Spec

**Date**: 2026-03-26
**Status**: Draft

## Problem

When opening a historical session without explicit adapter info (URL direct access, browser refresh, push notification), the frontend guesses the adapter from localStorage and initializes model/permissionMode/effort from the wrong adapter's prefs. The server later corrects the adapter via SESSION_CREATED, but model/prefs are never corrected → wrong UI state.

## Root Cause

`useChat` eagerly initializes everything (adapter, model, permissionMode, effort, adapterConfig) at mount time before knowing the correct adapter. When the adapter is unknown, it guesses wrong.

## Design Principle

**Don't guess. Wait.**

If the adapter is known (from prop or URL) → initialize immediately.
If the adapter is unknown → show loading → wait for server SESSION_CREATED → then initialize.

Server is the single source of truth for adapter identity.

## Changes

### Change 1: useChat — defer initialization until adapter is confirmed

**File:** `src/hooks/useChat.ts`

Current:
```typescript
const resolvedAdapter = initialAdapter || localStorage.getItem(STORAGE.ADAPTER) || 'claude';
const initialPrefs = loadAdapterPrefs(resolvedAdapter);
const [model, setModel] = useState(initialPrefs.model || '');
// ... all initialized immediately with possibly wrong adapter
```

New:
```typescript
// adapter is either known from prop/URL, or null (wait for server)
const [selectedAdapter, setSelectedAdapter] = useState<string | null>(initialAdapter || null);

// model/prefs initialized only after adapter is confirmed
const [model, setModel] = useState<string>('');
const [permissionMode, setPermissionMode] = useState<string>('default');
const [effort, setEffort] = useState<string>('');
```

When SESSION_CREATED arrives:
```typescript
case WS.SESSION_CREATED:
  setSessionId(msg.sessionId);
  if (msg.adapter) {
    setSelectedAdapter(msg.adapter);
    // Load correct prefs now that we know the adapter
    const prefs = loadAdapterPrefs(msg.adapter);
    setModel(prefs.model || '');
    setPermissionMode(msg.permissionMode || prefs.permissionMode || 'default');
    setEffort(prefs.effort || '');
  }
  break;
```

If `initialAdapter` was provided (session list click), everything initializes immediately at mount — no waiting, no loading state.

### Change 2: ChatView — show loading when adapter unknown

**File:** `src/components/ChatView.tsx`

If `selectedAdapter` is null (waiting for server), render a loading indicator instead of the chat UI:

```tsx
if (!selectedAdapter) {
  return <LoadingAnimation size="md" label="Connecting..." />;
}
```

This only happens for path B (URL) and C (notification). Path A (session list) always has adapter → no loading.

### Change 3: URL includes adapter when available

**File:** `src/App.tsx`

`navigateTo()` includes adapter in URL when known:
```typescript
const url = view.sessionId
  ? `/?view=chat&session=${view.sessionId}${view.adapter ? `&adapter=${view.adapter}` : ''}`
  : '/';
```

URL parser reads adapter from URL:
```typescript
const sessionId = params.get('session');
const adapter = params.get('adapter');
if (sessionId) {
  openChat(sessionId, undefined, adapter || undefined);
}
```

Push notification service worker also includes adapter in URL if available.

### Change 4: SERVER SESSION_CREATED includes adapter + cwd

**File:** `server/session-manager.ts`

`sendSessionCreated()` includes `adapter` name (already done) and `cwd`:
```typescript
send(conn, {
  type: WS.SESSION_CREATED,
  sessionId,
  adapter: adapterName,
  cwd: sessionObj?.cwd || resolvedCwd,
  permissionMode: sessionObj?.permissionMode,
});
```

The `cwd` allows the frontend to show the correct project name in the header even when opened from URL (which doesn't have `cwd`).

### Change 5: handleQuery verifies adapter on resumeSession

**File:** `server/session-manager.ts`

When `handleQuery` receives a QUERY with a `sessionId` (resume path), verify the adapter:
```typescript
if (sessionId) {
  const resolvedName = await resolveAdapterForSession(sessionId);
  if (resolvedName) adapterName = resolvedName; // override client's adapter with truth
  handle = await adapter.resumeSession(sessionId, cwd, { permissionMode });
}
```

### Change 6: Active sessions tab shows adapter badge

**File:** `src/components/SessionsView.tsx`

Add adapter brand badge to active session cards (same pattern as project sessions list).

## Flow After Fix

### Path A (Session List Click):
```
adapter = 'gemini' (from server API) → useChat initializes immediately → no loading
→ WS RECONNECT → server confirms → messages load → render
```

### Path B (URL Direct) / Path C (Push Notification):
```
adapter = null (unknown) → useChat does NOT initialize prefs → ChatView shows loading
→ WS RECONNECT → server SESSION_CREATED { adapter: 'gemini', cwd: '...' }
→ useChat sets adapter, loads correct prefs → loading disappears → messages load → render
```

### Path B with adapter in URL:
```
URL: ?session=UUID&adapter=gemini
adapter = 'gemini' (from URL) → useChat initializes immediately → no loading
→ WS RECONNECT → server confirms → messages load → render
```

## Verification

1. **Session list → Gemini session**: Loads immediately, correct adapter/model/messages
2. **URL `?session=UUID` (no adapter)**: Shows loading → then correct adapter/messages
3. **URL `?session=UUID&adapter=gemini`**: Loads immediately, no flash
4. **Browser refresh on chat**: Adapter from URL → immediate load
5. **Push notification click**: Loading → then correct session
6. **Two tabs same session**: Both show correct adapter, messages sync
7. **Send from Tab A**: Tab B sees user message + thinking + response
8. **Active sessions tab**: Shows adapter badge
9. **New Chat (all adapters)**: Still works correctly
