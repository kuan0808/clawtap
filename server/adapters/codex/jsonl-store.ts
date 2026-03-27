import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { stripMarker } from '../shared/content-utils.js';
import { CodexTranscriptParser } from './transcript-parser.js';
import type { CodexJsonlEntry } from './transcript-parser.js';
import type { DirectoryEntry, MessagesResult } from '../interface.js';
import type { SessionInfo } from '../../types/adapter.js';

// --- Constants ---

export const CODEX_DIR: string = join(homedir(), '.codex');
export const SESSIONS_DIR: string = join(CODEX_DIR, 'sessions');
export const HISTORY_FILE: string = join(CODEX_DIR, 'history.jsonl');

// --- History index entry ---

interface HistoryEntry {
  session_id: string;
  ts: number;
  text: string;
}

// --- Helpers ---

/**
 * Scan ~/.codex/sessions/YYYY/MM/DD/ directories from newest to oldest.
 * Match filename containing the session UUID.
 * Filename pattern: rollout-YYYY-MM-DDTHH-MM-SS-{uuid}.jsonl
 *
 * Strategy: list year/month/day dirs in descending order so the newest
 * match is found first — most session lookups are for recent sessions.
 */
export async function findSessionFile(sessionId: string, sessionsDir?: string): Promise<string | null> {
  const baseDir = sessionsDir || SESSIONS_DIR;

  let years: string[];
  try {
    years = await readdir(baseDir);
  } catch {
    return null;
  }

  // Sort descending (newest first)
  years.sort((a, b) => b.localeCompare(a));

  for (const year of years) {
    const yearPath = join(baseDir, year);
    const yearStat = await stat(yearPath).catch(() => null);
    if (!yearStat?.isDirectory()) continue;

    let months: string[];
    try {
      months = await readdir(yearPath);
    } catch {
      continue;
    }
    months.sort((a, b) => b.localeCompare(a));

    for (const month of months) {
      const monthPath = join(yearPath, month);
      const monthStat = await stat(monthPath).catch(() => null);
      if (!monthStat?.isDirectory()) continue;

      let days: string[];
      try {
        days = await readdir(monthPath);
      } catch {
        continue;
      }
      days.sort((a, b) => b.localeCompare(a));

      for (const day of days) {
        const dayPath = join(monthPath, day);
        const dayStat = await stat(dayPath).catch(() => null);
        if (!dayStat?.isDirectory()) continue;

        let files: string[];
        try {
          files = await readdir(dayPath);
        } catch {
          continue;
        }

        // Look for a file that contains the session UUID
        for (const file of files) {
          if (file.endsWith('.jsonl') && file.includes(sessionId)) {
            return join(dayPath, file);
          }
        }
      }
    }
  }

  return null;
}

// --- Session meta parsing ---

interface SessionMeta {
  cwd: string | null;
  model: string | null;
}

async function parseSessionMeta(filePath: string): Promise<SessionMeta> {
  const stream = createReadStream(filePath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd: string | null = null;
  let model: string | null = null;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry: CodexJsonlEntry = JSON.parse(line);
        if (entry.type === 'session_meta') {
          cwd = entry.payload?.cwd ?? null;
          model = entry.payload?.model_provider ?? entry.payload?.model ?? null;
          break;
        }
        // Also check turn_context for model info
        if (entry.type === 'turn_context' && entry.payload?.model) {
          model = entry.payload.model;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { cwd, model };
}

// --- Session Listing ---

export async function getSessions(dir?: string, limit?: number): Promise<SessionInfo[]> {
  // Read history.jsonl for fast session index
  let historyEntries: HistoryEntry[] = [];

  try {
    const stream = createReadStream(HISTORY_FILE);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          if (entry.session_id && entry.ts) {
            historyEntries.push(entry);
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    // history.jsonl doesn't exist or is unreadable — return empty
    return [];
  }

  // Sort by timestamp descending (newest first)
  historyEntries.sort((a, b) => b.ts - a.ts);

  // Deduplicate by session_id — history.jsonl has one entry per user message,
  // keep only the first (newest) entry per session
  const seen = new Set<string>();
  historyEntries = historyEntries.filter(e => {
    if (seen.has(e.session_id)) return false;
    seen.add(e.session_id);
    return true;
  });

  // Apply limit
  if (limit && limit > 0) {
    historyEntries = historyEntries.slice(0, limit);
  }

  // For each history entry, find the JSONL file and parse session_meta
  const sessions = await Promise.all(
    historyEntries.map(async (entry): Promise<SessionInfo | null> => {
      try {
        const filePath = await findSessionFile(entry.session_id);

        let cwd: string | null = null;
        let model: string | null = null;

        if (filePath) {
          const meta = await parseSessionMeta(filePath);
          cwd = meta.cwd;
          model = meta.model;
        }

        return {
          sessionId: entry.session_id,
          cwd,
          lastModified: entry.ts * 1000, // Convert to ms timestamp
          firstPrompt: entry.text
            ? stripMarker(entry.text).slice(0, 200)
            : null,
          model,
        };
      } catch {
        return null;
      }
    })
  );

  let result = sessions.filter((s): s is SessionInfo => s !== null);

  // Filter by directory if provided (same behavior as Claude's per-project filtering)
  if (dir) {
    result = result.filter(s => s.cwd === dir);
  }

  return result;
}

// --- Message Reading ---

export async function getMessages(sessionId: string, dir?: string): Promise<MessagesResult> {
  const filePath = await findSessionFile(sessionId);

  if (!filePath) {
    return { messages: [], lastModified: null };
  }

  try {
    const entries: CodexJsonlEntry[] = [];
    const stream = createReadStream(filePath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry: CodexJsonlEntry = JSON.parse(line);
          entries.push(entry);
        } catch {
          // Skip unparseable lines
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    const parser = new CodexTranscriptParser();
    const messages = parser.parseForHistory(entries);

    const fileMtime = await stat(filePath);
    return { messages, lastModified: fileMtime.mtime.toISOString() };
  } catch {
    return { messages: [], lastModified: null };
  }
}

// --- Directory Browser ---

export async function listDirectory(dirPath?: string): Promise<DirectoryEntry[]> {
  const target = dirPath || homedir();
  const entries = await readdir(target, { withFileTypes: true });
  const visible = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  const dirs = await Promise.all(
    visible.map(async (entry): Promise<DirectoryEntry> => {
      const fullPath = join(target, entry.name);
      let hasChildren = false;
      try {
        const children = await readdir(fullPath, { withFileTypes: true });
        hasChildren = children.some((c) => c.isDirectory() && !c.name.startsWith('.'));
      } catch {}
      return { name: entry.name, path: fullPath, hasChildren };
    })
  );

  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}
