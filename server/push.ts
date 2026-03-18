import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { AppConfig } from './config.js';
import { pushSubs as dbPushSubs, type PushSubRow } from './db.js';

interface PushSubscriptionEntry {
  endpoint: string;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

// In-memory cache (populated from SQLite on init)
let subscriptions: PushSubscriptionEntry[] = [];
let cachedVapidPublicKey: string | null = null;

// Pending session notification counts (in-memory, resets on restart)
const pendingSessions = new Map<string, number>(); // sessionId -> count

export function initPush(config: AppConfig): void {
  mkdirSync(config.clawtapDir, { recursive: true });

  const vapidPath = config.paths.vapidKeys;

  // Load or generate VAPID keys
  let vapidKeys: { publicKey: string; privateKey: string };
  if (existsSync(vapidPath)) {
    vapidKeys = JSON.parse(readFileSync(vapidPath, 'utf-8'));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2));
    console.log('[push] Generated new VAPID keys');
  }

  const email = process.env.VAPID_EMAIL || 'noreply@clawtap.local';
  cachedVapidPublicKey = vapidKeys.publicKey;
  webpush.setVapidDetails(`mailto:${email}`, vapidKeys.publicKey, vapidKeys.privateKey);

  // Load subscriptions from SQLite into in-memory cache
  const rows = dbPushSubs.getAll();
  subscriptions = rows.map(row => ({
    endpoint: row.endpoint,
    subscription: {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    },
  }));

  console.log(`[push] Initialized with ${subscriptions.length} subscription(s)`);
}

export function getVapidPublicKey(): string | null {
  return cachedVapidPublicKey;
}

export function saveSubscription(subscription: PushSubscriptionEntry['subscription']): void {
  // Save to SQLite
  dbPushSubs.save(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
  // Update in-memory cache
  subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  subscriptions.push({ endpoint: subscription.endpoint, subscription });
}

export function removeSubscription(endpoint: string): void {
  // Remove from SQLite
  dbPushSubs.remove(endpoint);
  // Update in-memory cache
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
}

export function incrementPending(sessionId: string): number {
  const count = (pendingSessions.get(sessionId) || 0) + 1;
  pendingSessions.set(sessionId, count);
  return _totalPending();
}

export function clearPending(sessionId: string): number {
  pendingSessions.delete(sessionId);
  return _totalPending();
}

export function getPendingSessions(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sid, count] of pendingSessions) {
    result[sid] = count;
  }
  return result;
}

export async function sendPush(payload: unknown): Promise<void> {
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  const expired: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async ({ endpoint, subscription }) => {
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired — mark for removal
          expired.push(endpoint);
        } else {
          console.error(`[push] Failed to send to ${endpoint.slice(0, 50)}:`, e.message);
        }
      }
    })
  );

  // Clean up expired subscriptions
  if (expired.length > 0) {
    for (const ep of expired) {
      dbPushSubs.remove(ep);
    }
    subscriptions = subscriptions.filter(s => !expired.includes(s.endpoint));
    console.log(`[push] Removed ${expired.length} expired subscription(s)`);
  }
}

function _totalPending(): number {
  let total = 0;
  for (const count of pendingSessions.values()) total += count;
  return total;
}
