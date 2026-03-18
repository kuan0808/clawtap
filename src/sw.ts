/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Precache static assets (injected by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);

// Push notification handler — server already filters by clientCount,
// so we always show the notification if one is received.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  event.waitUntil((async () => {
    // Update badge (handle 0 explicitly to clear)
    const badgeValue = payload.data?.badge;
    if (typeof badgeValue === 'number') {
      badgeValue > 0
        ? await navigator.setAppBadge?.(badgeValue)
        : await navigator.clearAppBadge?.();
    }

    // Forward to app clients for real-time UI updates (e.g. pending badges)
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      c.postMessage({ type: 'PUSH_RECEIVED', sessionId: payload.data?.sessionId, badge: badgeValue });
    }

    // Silent push (no title) — badge-only update, don't show notification
    if (!payload.title) return;

    // Always show notification — server already filtered by clientCount
    return self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: payload.tag || payload.data?.sessionId || 'default',
      data: payload.data,
    });
  })());
});

// Notification click — open app and navigate to session
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const url = sessionId ? `/?session=${sessionId}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if ('focus' in c) {
          c.postMessage({ type: 'OPEN_SESSION', sessionId });
          return (c as WindowClient).focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
