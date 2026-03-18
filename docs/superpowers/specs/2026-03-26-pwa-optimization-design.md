# PWA Optimization Design Spec

**Date:** 2026-03-26
**Goal:** Bring CodeTap's PWA to production-grade quality — proper viewport handling, splash screens, install prompts, SW updates, badge management, draft persistence, and navigation history.

---

## Current State

CodeTap already has solid PWA foundations:
- Service Worker with Workbox precaching (vite-plugin-pwa, injectManifest)
- Web App Manifest (standalone, portrait, dark theme)
- Push notifications with badge support
- iOS meta tags (capable, black-translucent status bar)
- Offline detection + OfflineView
- overscroll-behavior: none, 16px inputs, h-dvh, safe-bottom

## What's Missing

### High Priority

#### 1. Viewport & Safe Areas
**Problem:** Missing `viewport-fit=cover`. Only bottom safe area handled — notch/Dynamic Island area not accounted for.

**Solution:**
- Add `viewport-fit=cover` to viewport meta tag in `index.html`
- Add CSS for top safe area: headers get `padding-top: env(safe-area-inset-top)`
- The standalone PWA mode on iOS with `black-translucent` status bar needs the content to extend behind the status bar — `viewport-fit=cover` enables this

**Files:** `index.html`, `src/index.css`

#### 2. Splash Screen / Launch Images
**Problem:** White flash on app startup — no branded loading experience.

**Solution:**
- Add `apple-mobile-web-app-startup-image` meta tags covering major iPhone sizes
- Use `media` attribute with `device-width`, `device-height`, and `device-pixel-ratio` queries
- Background: `#09090b` (matches theme), centered CodeTap mascot/logo
- Generate splash images as data URIs or static PNGs in `/public/splash/`
- Minimum coverage: iPhone SE, iPhone 14/15, iPhone 14/15 Pro Max, iPhone 16 Pro Max

**Files:** `index.html`, `public/splash/` (new directory)

#### 3. Android Install Prompt
**Problem:** No handling of `beforeinstallprompt` event — Android users never see install prompt.

**Solution:**
- Listen for `beforeinstallprompt` in App.tsx, store the event in state
- Show a dismissible install banner in SessionsView (below header)
- Banner text: "Install CodeTap for a better experience" with Install/Dismiss buttons
- On Install click: call `event.prompt()`, hide banner
- On Dismiss: hide banner, store dismissal in `localStorage` so it doesn't reappear
- After successful install (`appinstalled` event): hide banner permanently

**Files:** `src/App.tsx`, `src/components/SessionsView.tsx`

#### 4. Service Worker Update Notification
**Problem:** SW updates silently — user doesn't know a new version is available.

**Solution:**
- Listen for `controllerchange` on `navigator.serviceWorker` in App.tsx
- When detected, show a toast at bottom: "New version available" with Refresh button
- On click: `window.location.reload()`
- Toast auto-dismisses after 10s but can be manually dismissed

**Files:** `src/App.tsx`

### Medium Priority

#### 5. Badge Clear on Focus
**Problem:** App badge persists even when user is actively looking at the app.

**Solution:**
- In App.tsx, listen for `visibilitychange` event
- When `document.visibilityState === 'visible'`: call `navigator.clearAppBadge()` (with feature check)
- This ensures badge is cleared whenever user switches back to the app

**Files:** `src/App.tsx`

#### 6. Manifest Shortcuts
**Problem:** No quick actions from home screen long-press.

**Solution:**
- Add `shortcuts` array to manifest in vite.config.ts:
  - "New Chat" — url: `/?action=newchat`, icon: `chat-bubble-icon`
- In App.tsx, check for `?action=newchat` param and navigate accordingly

**Files:** `vite.config.ts`, `src/App.tsx`

#### 7. Input Draft Auto-Save
**Problem:** Typed text lost if app is backgrounded or crashes.

**Solution:**
- In ShimmerInput: on every input change, debounce-save to `localStorage` with key `codetap:draft:{sessionId}`
- On mount: restore draft from localStorage if present
- On successful send or explicit clear: delete the draft
- Debounce: 500ms to avoid excessive writes

**Files:** `src/components/ShimmerInput.tsx`

#### 8. Manifest Screenshots
**Problem:** Missing screenshots for app stores and install prompts.

**Solution:**
- Add `screenshots` array to manifest in vite.config.ts
- Provide at minimum:
  - 1 narrow screenshot (phone, 1080x1920) — chat view
  - 1 wide screenshot (tablet/desktop, 1920x1080) — sessions view
- Store in `public/screenshots/`

**Files:** `vite.config.ts`, `public/screenshots/` (new directory)

### Low Priority

#### 9. Slow Network Detection
**Problem:** No feedback when on slow connection.

**Solution:**
- Check `navigator.connection?.effectiveType` (with feature detection)
- When `2g` or `slow-2g`: show a subtle indicator in StatusBar ("Slow connection")
- Re-check on `change` event of `navigator.connection`

**Files:** `src/components/StatusBar.tsx`

#### 10. History API Navigation
**Problem:** Browser back gesture doesn't work — app uses `sessionStorage` for view state, no history stack.

**Solution:**
- In App.tsx, use `history.pushState()` when navigating between views
- Listen for `popstate` event to handle back navigation
- Map each view to a history entry: `sessions`, `chat/{sessionId}`, `settings`, `newchat/{cwd}`
- This enables iOS swipe-back gesture and Android back button in standalone mode

**Files:** `src/App.tsx`

#### 11. OpenGraph Meta Tags
**Problem:** No social sharing metadata.

**Solution:**
- Add to `index.html`:
  - `og:title`: "CodeTap"
  - `og:description`: "Use Claude Code from your phone"
  - `og:image`: link to a social card image
  - `og:type`: "website"
  - `twitter:card`: "summary"

**Files:** `index.html`

---

## Design Principles

1. **Progressive enhancement** — All PWA features use feature detection. App works fine without them.
2. **No new dependencies** — Everything is native Web APIs or existing vite-plugin-pwa config.
3. **Minimal UI additions** — Install banner and SW update toast are the only new UI elements.
4. **Respect user choice** — Install prompt is dismissible and remembers dismissal.

## Out of Scope

- Full offline-first with background sync (current offline detection is sufficient)
- Push notification permission prompt UI (current flow works)
- Image compression before upload
- Orientation lock via Screen Orientation API
