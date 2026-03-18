import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AppConfig } from './config.js';

let db: BetterSqlite3.Database | null = null;

// --- Lifecycle ---

export function initDB(config: AppConfig): void {
  const dbPath = config.paths.db;
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_used TEXT
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT NOT NULL,
      attempted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip);

    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_stats (
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stats_session ON session_stats(session_id);

    CREATE TABLE IF NOT EXISTS session_reviews (
      id TEXT PRIMARY KEY,
      parent_cli_session_id TEXT NOT NULL,
      child_cli_session_id TEXT NOT NULL,
      child_adapter TEXT NOT NULL,
      parent_adapter TEXT NOT NULL DEFAULT 'claude',
      anchor_message_id TEXT,
      review_prompt TEXT,
      review_title TEXT,
      message_count INTEGER DEFAULT 0,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT DEFAULT NULL,
      end_anchor_message_id TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_parent ON session_reviews(parent_cli_session_id);

    CREATE TABLE IF NOT EXISTS saved_instructions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      instruction TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add parent_adapter column to session_reviews if missing
  const reviewInfo = db.prepare("PRAGMA table_info('session_reviews')").all() as { name: string }[];
  if (!reviewInfo.some(c => c.name === 'parent_adapter')) {
    db.exec("ALTER TABLE session_reviews ADD COLUMN parent_adapter TEXT NOT NULL DEFAULT 'claude'");
  }

  // Migration: add end_anchor_message_id column to session_reviews if missing
  if (!reviewInfo.some(c => c.name === 'end_anchor_message_id')) {
    db.exec("ALTER TABLE session_reviews ADD COLUMN end_anchor_message_id TEXT DEFAULT NULL");
  }

  // Drop legacy sessions table (no longer used — adapters use in-memory Maps)
  db.exec('DROP TABLE IF EXISTS sessions');

  console.log('[db] SQLite database initialized at', dbPath);
}

export function closeDB(): void {
  _stmts = null;
  if (db) {
    db.close();
    db = null;
    console.log('[db] Database closed');
  }
}

function getDB(): BetterSqlite3.Database {
  if (!db) throw new Error('Database not initialized — call initDB() first');
  return db;
}

// --- Cached Prepared Statements ---

interface PreparedStatements {
  pushSubsSave: BetterSqlite3.Statement;
  pushSubsRemove: BetterSqlite3.Statement;
  pushSubsGetAll: BetterSqlite3.Statement;
  pushSubsMarkUsed: BetterSqlite3.Statement;
  rateLimitRecord: BetterSqlite3.Statement;
  rateLimitCountRecent: BetterSqlite3.Statement;
  rateLimitCleanup: BetterSqlite3.Statement;
  preferencesGet: BetterSqlite3.Statement;
  preferencesSet: BetterSqlite3.Statement;
  reviewCreate: BetterSqlite3.Statement;
  reviewGetById: BetterSqlite3.Statement;
  reviewGetActiveForParent: BetterSqlite3.Statement;
  reviewGetAllForParent: BetterSqlite3.Statement;
  reviewGetAllChildIds: BetterSqlite3.Statement;
  reviewEnd: BetterSqlite3.Statement;
  reviewUpdateChildCliId: BetterSqlite3.Statement;
  instructionCreate: BetterSqlite3.Statement;
  instructionGetAll: BetterSqlite3.Statement;
  instructionDelete: BetterSqlite3.Statement;
}

let _stmts: PreparedStatements | null = null;

function stmts(): PreparedStatements {
  if (!_stmts) {
    const d = getDB();
    _stmts = {
      // push_subscriptions
      pushSubsSave: d.prepare(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth)
        VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh = excluded.p256dh,
          auth = excluded.auth
      `),
      pushSubsRemove: d.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint = ?`
      ),
      pushSubsGetAll: d.prepare(
        `SELECT * FROM push_subscriptions`
      ),
      pushSubsMarkUsed: d.prepare(
        `UPDATE push_subscriptions SET last_used = datetime('now') WHERE endpoint = ?`
      ),
      // rate_limit
      rateLimitRecord: d.prepare(
        `INSERT INTO login_attempts (ip) VALUES (?)`
      ),
      rateLimitCountRecent: d.prepare(
        `SELECT COUNT(*) AS cnt FROM login_attempts
         WHERE ip = ? AND attempted_at > datetime('now', '-' || ? || ' seconds')`
      ),
      rateLimitCleanup: d.prepare(
        `DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 hour')`
      ),
      // preferences
      preferencesGet: d.prepare(
        `SELECT value FROM user_preferences WHERE key = ?`
      ),
      preferencesSet: d.prepare(`
        INSERT INTO user_preferences (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `),
      // session_reviews
      reviewCreate: d.prepare(
        `INSERT INTO session_reviews (id, parent_cli_session_id, child_cli_session_id, child_adapter, parent_adapter, anchor_message_id, review_prompt, review_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      reviewGetById: d.prepare(
        `SELECT * FROM session_reviews WHERE id = ?`
      ),
      reviewGetActiveForParent: d.prepare(
        `SELECT * FROM session_reviews WHERE parent_cli_session_id = ? AND ended_at IS NULL`
      ),
      reviewGetAllForParent: d.prepare(
        `SELECT * FROM session_reviews WHERE parent_cli_session_id = ? ORDER BY started_at`
      ),
      reviewGetAllChildIds: d.prepare(
        `SELECT DISTINCT child_cli_session_id FROM session_reviews`
      ),
      reviewEnd: d.prepare(
        `UPDATE session_reviews SET ended_at = datetime('now'), message_count = ?, end_anchor_message_id = ? WHERE id = ?`
      ),
      reviewUpdateChildCliId: d.prepare(
        `UPDATE session_reviews SET child_cli_session_id = ? WHERE child_cli_session_id = ?`
      ),
      // saved_instructions
      instructionCreate: d.prepare(
        `INSERT INTO saved_instructions (id, label, instruction) VALUES (?, ?, ?)`
      ),
      instructionGetAll: d.prepare(
        `SELECT * FROM saved_instructions ORDER BY created_at ASC`
      ),
      instructionDelete: d.prepare(
        `DELETE FROM saved_instructions WHERE id = ?`
      ),
    };
  }
  return _stmts;
}

// --- Session Review Types ---

export interface SessionReviewRow {
  id: string;
  parent_cli_session_id: string;
  child_cli_session_id: string;
  child_adapter: string;
  parent_adapter: string;
  anchor_message_id: string | null;
  review_prompt: string | null;
  review_title: string | null;
  message_count: number;
  started_at: string;
  ended_at: string | null;
  end_anchor_message_id: string | null;
}

// --- Push Subscription Operations ---

export interface PushSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_used: string | null;
}

export const pushSubs = {
  save(endpoint: string, p256dh: string, auth: string): void {
    stmts().pushSubsSave.run(endpoint, p256dh, auth);
  },

  remove(endpoint: string): void {
    stmts().pushSubsRemove.run(endpoint);
  },

  getAll(): PushSubRow[] {
    return stmts().pushSubsGetAll.all() as PushSubRow[];
  },

  markUsed(endpoint: string): void {
    stmts().pushSubsMarkUsed.run(endpoint);
  },
};

// --- Rate Limit Operations ---

export const rateLimit = {
  record(ip: string): void {
    stmts().rateLimitRecord.run(ip);
  },

  countRecent(ip: string, windowSeconds: number = 60): number {
    const row = stmts().rateLimitCountRecent.get(ip, windowSeconds) as { cnt: number };
    return row.cnt;
  },

  cleanup(): void {
    stmts().rateLimitCleanup.run();
  },
};

// --- User Preferences Operations ---

export const preferences = {
  get(key: string): string | undefined {
    const row = stmts().preferencesGet.get(key) as { value: string } | undefined;
    return row?.value;
  },

  set(key: string, value: string): void {
    stmts().preferencesSet.run(key, value);
  },
};

// --- Session Review Operations ---

let _childIdCache: Set<string> | null = null;

export const sessionReviews = {
  create(
    id: string,
    parentCliId: string,
    childCliId: string,
    childAdapter: string,
    parentAdapter: string,
    anchorMsgId?: string,
    prompt?: string,
    title?: string
  ): void {
    stmts().reviewCreate.run(
      id,
      parentCliId,
      childCliId,
      childAdapter,
      parentAdapter,
      anchorMsgId ?? null,
      prompt ?? null,
      title ?? null
    );
    _childIdCache = null; // invalidate cache
  },

  getById(reviewId: string): SessionReviewRow | undefined {
    return stmts().reviewGetById.get(reviewId) as SessionReviewRow | undefined;
  },

  getActiveForParent(parentCliSessionId: string): SessionReviewRow[] {
    return stmts().reviewGetActiveForParent.all(parentCliSessionId) as SessionReviewRow[];
  },

  getAllForParent(parentCliSessionId: string): SessionReviewRow[] {
    return stmts().reviewGetAllForParent.all(parentCliSessionId) as SessionReviewRow[];
  },

  getAllChildIds(): Set<string> {
    if (_childIdCache) return _childIdCache;
    const rows = stmts().reviewGetAllChildIds.all() as { child_cli_session_id: string }[];
    _childIdCache = new Set(rows.map(r => r.child_cli_session_id));
    return _childIdCache;
  },

  endReview(reviewId: string, messageCount: number = 0, endAnchorMessageId?: string): void {
    stmts().reviewEnd.run(messageCount, endAnchorMessageId || null, reviewId);
    _childIdCache = null; // invalidate cache
  },

  updateChildCliId(currentId: string, newCliId: string): void {
    stmts().reviewUpdateChildCliId.run(newCliId, currentId);
    _childIdCache = null; // invalidate cache
  },
};

// --- Saved Instructions Operations ---

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
