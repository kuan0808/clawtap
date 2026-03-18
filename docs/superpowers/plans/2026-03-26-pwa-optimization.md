# PWA Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring CodeTap's PWA to production-grade quality with proper viewport handling, splash screens, install prompts, SW updates, badge management, draft persistence, navigation history, and social meta tags.

**Architecture:** All changes are additive — native Web APIs with feature detection, no new dependencies. App.tsx gains PWA lifecycle effects. ShimmerInput gains draft persistence. Manifest and HTML get richer metadata.

**Tech Stack:** Vite + vite-plugin-pwa + native Web APIs (beforeinstallprompt, History API, Network Information API)

**Spec:** `docs/superpowers/specs/2026-03-26-pwa-optimization-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `index.html` | Viewport, splash images, OG tags | Modify |
| `vite.config.ts` | Manifest shortcuts, screenshots | Modify |
| `src/App.tsx` | Install prompt, SW update, badge clear, history API | Modify |
| `src/components/SessionsView.tsx` | Install banner UI | Modify |
| `src/components/ShimmerInput.tsx` | Draft auto-save | Modify |
| `src/components/StatusBar.tsx` | Slow network indicator | Modify |
| `src/index.css` | Safe area utilities | Modify |
| `public/splash/` | iOS splash screen images | Create |
| `public/screenshots/` | Manifest screenshots | Create |

---

## Task 1: Viewport & Safe Areas

**Files:**
- Modify: `index.html`
- Modify: `src/index.css`

- [ ] **Step 1: Add viewport-fit=cover to index.html**

Change the viewport meta tag:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
```

- [ ] **Step 2: Add safe area utilities to index.css**

After the existing `.safe-bottom` rule:
```css
.safe-top {
  padding-top: env(safe-area-inset-top);
}

.safe-x {
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
```

- [ ] **Step 3: Verify — open in iOS simulator or DevTools, check notch area**

- [ ] **Step 4: Commit**
```bash
git add index.html src/index.css
git commit -m "feat(pwa): viewport-fit=cover and full safe area utilities"
```

---

## Task 2: iOS Splash Screens

**Files:**
- Create: `public/splash/` directory
- Modify: `index.html`

- [ ] **Step 1: Create splash screen SVG generator script**

Create a simple inline SVG splash as a data URI approach in index.html. This avoids needing to generate multiple PNGs. Use `apple-mobile-web-app-startup-image` with media queries for major iPhone sizes.

Add to `<head>` in index.html, after the apple-touch-icon link:
```html
<!-- iOS Splash Screens -->
<meta name="apple-mobile-web-app-title" content="CodeTap" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1290x2796.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1179x2556.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1284x2778.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1170x2532.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1125x2436.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)"
  href="/splash/splash-1242x2688.png" />
<link rel="apple-touch-startup-image"
  media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)"
  href="/splash/splash-750x1334.png" />
```

- [ ] **Step 2: Generate splash screen PNGs via Node.js canvas script**

Create `scripts/generate-splash.mjs` that uses the built-in `node:canvas` or a simple HTML-to-PNG approach. Simplest method: create a single-use Node script that writes minimal HTML to a temp file and uses `sharp` or pure SVG-to-PNG. Actually, the most practical approach for a CLI tool: use a simple Node script that generates SVG strings and writes them as `.svg` files that Safari can use (Safari accepts SVG for startup images). If SVG doesn't work, use a single high-res PNG and reference it without media queries as a universal fallback.

Practical fallback: Create `public/splash/` with a single `splash.svg` (dark bg + centered "CodeTap" text), referenced without media queries. Remove per-device media queries from Step 1 and use a single universal link tag instead:
```html
<link rel="apple-touch-startup-image" href="/splash/splash.svg" />
```
If SVG is not supported by Safari for startup images (it isn't), generate a single 1290x2796 PNG using a canvas script at build time, or manually create one. The key requirement is: dark background (#09090b), centered CodeTap text or mascot.

- [ ] **Step 3: Verify — add to home screen on iOS, check splash appears**

- [ ] **Step 4: Commit**
```bash
git add -f public/splash/ index.html
git commit -m "feat(pwa): iOS splash screens for major iPhone sizes"
```

---

## Task 3: Android Install Prompt

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/SessionsView.tsx`

- [ ] **Step 1: Add install prompt state to App.tsx**

Add state and effect near the top of `App()`:
```tsx
const [installPrompt, setInstallPrompt] = useState<any>(null);
const [installDismissed, setInstallDismissed] = useState(
  () => localStorage.getItem('codetap:install-dismissed') === 'true'
);

useEffect(() => {
  const handler = (e: Event) => {
    e.preventDefault();
    setInstallPrompt(e);
  };
  window.addEventListener('beforeinstallprompt', handler);
  const installedHandler = () => {
    setInstallPrompt(null);
    setInstallDismissed(true);
    localStorage.setItem('codetap:install-dismissed', 'true');
  };
  window.addEventListener('appinstalled', installedHandler);
  return () => {
    window.removeEventListener('beforeinstallprompt', handler);
    window.removeEventListener('appinstalled', installedHandler);
  };
}, []);
```

- [ ] **Step 2: Pass install props to SessionsView**

Update the SessionsView rendering in App.tsx:
```tsx
<SessionsView
  onOpenChat={openChat}
  onLogout={handleLogout}
  onOpenSettings={() => setView({ name: 'settings' })}
  installPrompt={!installDismissed ? installPrompt : null}
  onInstall={async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const result = await installPrompt.userChoice;
      if (result.outcome === 'accepted') {
        setInstallPrompt(null);
        setInstallDismissed(true);
        localStorage.setItem('codetap:install-dismissed', 'true');
      }
    }
  }}
  onDismissInstall={() => {
    setInstallDismissed(true);
    localStorage.setItem('codetap:install-dismissed', 'true');
  }}
/>
```

- [ ] **Step 3: Add install banner to SessionsView**

Add to SessionsView props interface and render a banner below the header when `installPrompt` is truthy:
```tsx
// Add to props
installPrompt?: any;
onInstall?: () => void;
onDismissInstall?: () => void;

// Render below the header, before the tab bar
{installPrompt && (
  <div className="flex items-center gap-3 px-4 py-2.5 bg-accent/10 border-b border-accent/20">
    <span className="text-xs text-text flex-1 font-mono">Install CodeTap for a better experience</span>
    <button onClick={onInstall} className="text-xs font-medium text-accent hover:text-accent-light">Install</button>
    <button onClick={onDismissInstall} className="text-xs text-text-dim hover:text-text">Dismiss</button>
  </div>
)}
```

- [ ] **Step 4: Verify — open in Chrome Android (or DevTools Application panel), check install banner appears**

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx src/components/SessionsView.tsx
git commit -m "feat(pwa): Android install prompt with dismissible banner"
```

---

## Task 4: Service Worker Update Notification

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add SW update detection and toast state**

Add near other effects in App():
```tsx
const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);

useEffect(() => {
  const handleControllerChange = () => setSwUpdateAvailable(true);
  navigator.serviceWorker?.addEventListener('controllerchange', handleControllerChange);
  return () => navigator.serviceWorker?.removeEventListener('controllerchange', handleControllerChange);
}, []);
```

- [ ] **Step 2: Render update toast**

Add before the closing `</div>` or at the bottom of the main render:
```tsx
{swUpdateAvailable && (
  <div className="fixed bottom-6 left-4 right-4 bg-surface border border-accent/30 rounded-md px-4 py-3 flex items-center justify-between z-50 shadow-lg">
    <span className="text-sm text-text font-mono">New version available</span>
    <div className="flex gap-2">
      <button
        onClick={() => window.location.reload()}
        className="text-sm font-medium text-accent hover:text-accent-light"
      >Refresh</button>
      <button
        onClick={() => setSwUpdateAvailable(false)}
        className="text-sm text-text-dim hover:text-text"
      >Later</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Verify — modify SW file, rebuild, check toast appears**

- [ ] **Step 4: Commit**
```bash
git add src/App.tsx
git commit -m "feat(pwa): service worker update notification toast"
```

---

## Task 5: Badge Clear on Focus

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add visibility change listener**

Add with other effects in App():
```tsx
useEffect(() => {
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      navigator.clearAppBadge?.();
    }
  };
  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}, []);
```

- [ ] **Step 2: Commit**
```bash
git add src/App.tsx
git commit -m "feat(pwa): clear app badge when app becomes visible"
```

---

## Task 6: Manifest Shortcuts & Screenshots

**Files:**
- Modify: `vite.config.ts`
- Create: `public/screenshots/` (placeholder)

- [ ] **Step 1: Add shortcuts to manifest in vite.config.ts**

Add after the `icons` array in the manifest config:
```ts
shortcuts: [
  {
    name: 'New Chat',
    short_name: 'New',
    url: '/?action=newchat',
    icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
  },
],
categories: ['developer-tools', 'productivity'],
```

- [ ] **Step 2: Handle ?action=newchat in App.tsx**

Add after the existing `?session=` URL handler:
```tsx
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'newchat' && authed) {
    window.history.replaceState({}, '', '/');
    // Shortcut just brings user to sessions view — they pick a project from there
    setView({ name: 'sessions' });
  }
}, [authed]);
```

- [ ] **Step 3: Add screenshots placeholder to manifest**

Add to manifest in vite.config.ts:
```ts
screenshots: [
  {
    src: '/screenshots/narrow.png',
    sizes: '1080x1920',
    type: 'image/png',
    form_factor: 'narrow',
    label: 'CodeTap Chat View',
  },
  {
    src: '/screenshots/wide.png',
    sizes: '1920x1080',
    type: 'image/png',
    form_factor: 'wide',
    label: 'CodeTap Sessions View',
  },
],
```

Create `public/screenshots/` directory with placeholder images (can be actual screenshots later).

- [ ] **Step 4: Commit**
```bash
git add vite.config.ts src/App.tsx
git add -f public/screenshots/ 2>/dev/null || true
git commit -m "feat(pwa): manifest shortcuts, categories, and screenshots config"
```

---

## Task 7: Input Draft Auto-Save

**Files:**
- Modify: `src/components/ShimmerInput.tsx`

- [ ] **Step 1: Add draft persistence to ShimmerInput**

ShimmerInput doesn't receive a sessionId prop, so use a global draft key. Add after the existing state declarations:

```tsx
const DRAFT_KEY = 'codetap:draft';

// Restore draft on mount
useEffect(() => {
  if (!initialText) {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) setText(saved);
  }
}, []);

// Debounce-save draft on text change
const saveTimer = useRef<ReturnType<typeof setTimeout>>();
useEffect(() => {
  clearTimeout(saveTimer.current);
  if (text.trim()) {
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, text);
    }, 500);
  } else {
    localStorage.removeItem(DRAFT_KEY);
  }
  return () => clearTimeout(saveTimer.current);
}, [text]);
```

- [ ] **Step 2: Clear draft on send**

In the existing send handler, add `localStorage.removeItem(DRAFT_KEY)` after `onSend(...)`:
```tsx
// Find the handleSend function and add after onSend call:
localStorage.removeItem(DRAFT_KEY);
```

- [ ] **Step 3: Verify — type text, close tab, reopen, check draft restored**

- [ ] **Step 4: Commit**
```bash
git add src/components/ShimmerInput.tsx
git commit -m "feat(pwa): auto-save input draft to localStorage with debounce"
```

---

## Task 8: Slow Network Detection

**Files:**
- Modify: `src/components/StatusBar.tsx`

- [ ] **Step 1: Add network quality detection**

Add a hook at the top of StatusBar component:
```tsx
const [slowNetwork, setSlowNetwork] = useState(false);

useEffect(() => {
  const conn = (navigator as any).connection;
  if (!conn) return;
  const check = () => {
    setSlowNetwork(conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g');
  };
  check();
  conn.addEventListener('change', check);
  return () => conn.removeEventListener('change', check);
}, []);
```

- [ ] **Step 2: Render slow network indicator**

Add inside the status bar, before or after the model display:
```tsx
{slowNetwork && (
  <span className="text-warning text-[10px] font-mono">Slow</span>
)}
```

- [ ] **Step 3: Commit**
```bash
git add src/components/StatusBar.tsx
git commit -m "feat(pwa): slow network indicator via Network Information API"
```

---

## Task 9: History API Navigation

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Push state on view changes**

Modify the `saveView` function to also push history state:
```tsx
function saveView(view: View) {
  sessionStorage.setItem('currentView', JSON.stringify(view));
  const url = view.name === 'chat' && view.sessionId
    ? `/?view=chat&session=${view.sessionId}`
    : view.name === 'settings'
      ? '/?view=settings'
      : '/';
  window.history.pushState({ view }, '', url);
}
```

- [ ] **Step 2: Listen for popstate (back button/gesture)**

Add effect in App():
```tsx
useEffect(() => {
  const handlePopState = (event: PopStateEvent) => {
    if (event.state?.view) {
      setView(event.state.view);
      sessionStorage.setItem('currentView', JSON.stringify(event.state.view));
    } else {
      setView({ name: 'sessions' });
      sessionStorage.setItem('currentView', JSON.stringify({ name: 'sessions' }));
    }
  };
  window.addEventListener('popstate', handlePopState);
  return () => window.removeEventListener('popstate', handlePopState);
}, []);
```

- [ ] **Step 3: Use replaceState for initial load (avoid double entry)**

In the existing `loadView()` function, after loading the view, replace the current history entry:
```tsx
// At the end of App() initialization, after first render:
useEffect(() => {
  window.history.replaceState({ view }, '', window.location.pathname + window.location.search);
}, []); // only on mount
```

- [ ] **Step 4: Verify — navigate sessions → chat → back gesture returns to sessions**

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx
git commit -m "feat(pwa): History API navigation for back gesture support"
```

---

## Task 10: OpenGraph Meta Tags

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add OG and Twitter meta tags to index.html**

Add before `</head>`:
```html
<!-- OpenGraph -->
<meta property="og:title" content="CodeTap" />
<meta property="og:description" content="Use Claude Code from your phone. Real-time mobile UI synced with your desktop terminal." />
<meta property="og:type" content="website" />
<meta property="og:image" content="/pwa-512x512.png" />
<meta name="twitter:card" content="summary" />
<meta name="description" content="Use Claude Code from your phone. Real-time mobile UI synced with your desktop terminal." />
```

- [ ] **Step 2: Commit**
```bash
git add index.html
git commit -m "feat(pwa): OpenGraph and Twitter Card meta tags"
```

---

## Verification

1. Run `npm run dev` in the worktree
2. Open in Chrome DevTools → Application panel:
   - Check manifest loads correctly with shortcuts, screenshots, categories
   - Check service worker is registered
3. Mobile testing (iOS):
   - Add to Home Screen → check splash screen appears
   - Verify content extends properly behind notch (viewport-fit=cover)
   - Test back gesture navigates correctly
4. Mobile testing (Android / Chrome):
   - Check install banner appears in SessionsView
   - Dismiss and verify it doesn't reappear
   - Install and verify banner disappears
5. Draft persistence:
   - Type text in input, close tab, reopen → text should be restored
   - Send message → draft should be cleared
6. Badge:
   - Receive push notification with badge → switch to app → badge clears
7. Network:
   - Throttle to 2G in DevTools → "Slow" indicator appears in StatusBar
