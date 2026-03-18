import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { extractUserText } from './message-utils.js';
import type { DirectoryEntry } from '../interface.js';
import type { SessionInfo } from '../../types/adapter.js';

// --- Constants ---
export const GEMINI_DIR: string = join(homedir(), '.gemini');
export const GEMINI_TMP_DIR: string = join(GEMINI_DIR, 'tmp');
export const GEMINI_PROJECTS_FILE: string = join(GEMINI_DIR, 'projects.json');

// --- Types ---

interface GeminiProjectsFile {
  projects?: Record<string, string>;
}

interface GeminiSessionFile {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: unknown[];
  summary?: string;
}

interface GeminiMessage {
  type?: string;  // 'user' | 'gemini' | 'error' | 'info' | 'warning'
  content?: unknown;
  model?: string;
}

// --- Helpers ---

function readProjectsJson(): GeminiProjectsFile {
  try {
    const raw = readFileSync(GEMINI_PROJECTS_FILE, 'utf-8');
    return JSON.parse(raw) as GeminiProjectsFile;
  } catch {
    return {};
  }
}

// --- Exported Functions ---

/**
 * Look up the Gemini project name for a given absolute directory path.
 * Reads ~/.gemini/projects.json which maps "/abs/path" → "project-name".
 */
export function getProjectName(dir: string): string | null {
  try {
    const data = readProjectsJson();
    return data.projects?.[dir] ?? null;
  } catch {
    return null;
  }
}

/**
 * List all project directories under ~/.gemini/tmp/.
 * If dir is provided, only return the matching project directory.
 */
function getProjectDirs(dir?: string): Array<{ projectDir: string; cwd: string | null }> {
  if (dir) {
    const projectName = getProjectName(dir);
    if (!projectName) return [];
    return [{ projectDir: join(GEMINI_TMP_DIR, projectName), cwd: dir }];
  }

  try {
    const entries = readdirSync(GEMINI_TMP_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const projectDir = join(GEMINI_TMP_DIR, e.name);
        // Attempt to read .project_root for the cwd
        let cwd: string | null = null;
        try {
          cwd = readFileSync(join(projectDir, '.project_root'), 'utf-8').trim() || null;
        } catch {
          // no .project_root — cwd stays null
        }
        return { projectDir, cwd };
      });
  } catch {
    return [];
  }
}

/**
 * List sessions for a project (or all projects if dir is omitted).
 * Returns SessionInfo[] sorted by lastModified descending.
 */
export function getSessions(dir?: string, limit?: number): SessionInfo[] {
  const projectDirs = getProjectDirs(dir);
  const sessions: SessionInfo[] = [];

  for (const { projectDir, cwd } of projectDirs) {
    const chatsDir = join(projectDir, 'chats');
    let files: string[];
    try {
      files = readdirSync(chatsDir);
    } catch {
      continue;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const filePath = join(chatsDir, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as GeminiSessionFile;

        const sessionId = data.sessionId ?? file.replace('.json', '');
        const lastModified = data.lastUpdated ?? data.startTime ?? null;

        // Extract firstPrompt from first user message
        let firstPrompt: string | null = null;
        if (Array.isArray(data.messages)) {
          for (const msg of data.messages) {
            const m = msg as GeminiMessage;
            if (m.type === 'user' && m.content != null) {
              const text = extractUserText(m.content);
              if (text.trim()) {
                firstPrompt = text.slice(0, 200);
                break;
              }
            }
          }
        }

        // Extract model from last gemini message
        let model: string | null = null;
        if (Array.isArray(data.messages)) {
          for (let i = data.messages.length - 1; i >= 0; i--) {
            const m = data.messages[i] as GeminiMessage;
            if (m.type === 'gemini' && m.model) {
              model = m.model;
              break;
            }
          }
        }

        sessions.push({
          sessionId,
          cwd,
          lastModified: lastModified ?? undefined,
          firstPrompt,
          model,
        });
      } catch {
        // skip malformed files
      }
    }
  }

  // Sort by lastModified descending, null-safe
  sessions.sort((a, b) => {
    const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
    const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
    return tb - ta;
  });

  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * Find the absolute path of a session file by UUID across all project dirs.
 * Returns null if not found.
 */
export function findSessionFile(sessionId: string): string | null {
  let projectDirs: string[];
  try {
    const entries = readdirSync(GEMINI_TMP_DIR, { withFileTypes: true });
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(GEMINI_TMP_DIR, e.name));
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const chatsDir = join(projectDir, 'chats');
    let files: string[];
    try {
      files = readdirSync(chatsDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(chatsDir, file);
      // Fast path: check if session UUID appears in filename before parsing
      if (file.includes(sessionId)) return filePath;
      // Slow path: parse JSON to check sessionId field
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as GeminiSessionFile;
        if (data.sessionId === sessionId) return filePath;
      } catch {
        // skip malformed files
      }
    }
  }

  return null;
}

/**
 * Read all messages from a session file.
 * If dir is provided, search only in that project's chats dir.
 */
export function getSessionMessages(
  sessionId: string,
  dir?: string
): { messages: unknown[]; lastModified: string | null } {
  // Determine candidate file paths
  let filePath: string | null = null;

  if (dir) {
    const projectName = getProjectName(dir);
    if (projectName) {
      const chatsDir = join(GEMINI_TMP_DIR, projectName, 'chats');
      // Try exact match first, then scan
      try {
        const files = readdirSync(chatsDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const fp = join(chatsDir, file);
          try {
            const raw = readFileSync(fp, 'utf-8');
            const data = JSON.parse(raw) as GeminiSessionFile;
            const fileSessionId = data.sessionId ?? file.replace('.json', '');
            if (fileSessionId === sessionId) {
              filePath = fp;
              break;
            }
          } catch {
            // skip
          }
        }
      } catch {
        // chats dir not readable
      }
    }
  } else {
    filePath = findSessionFile(sessionId);
  }

  if (!filePath) return { messages: [], lastModified: null };

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as GeminiSessionFile;
    const messages = Array.isArray(data.messages) ? data.messages : [];

    let lastModified: string | null = null;
    try {
      const s = statSync(filePath);
      lastModified = s.mtime.toISOString();
    } catch {
      lastModified = data.lastUpdated ?? data.startTime ?? null;
    }

    return { messages, lastModified };
  } catch {
    return { messages: [], lastModified: null };
  }
}

/**
 * List directory entries (non-hidden subdirectories) for the directory browser.
 * If path is omitted, defaults to the user's home directory.
 */
export function listDirectory(dirPath?: string): DirectoryEntry[] {
  const target = dirPath || homedir();
  try {
    const entries = readdirSync(target, { withFileTypes: true });
    const visible = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const dirs: DirectoryEntry[] = visible.map((entry) => {
      const fullPath = join(target, entry.name);
      let hasChildren = false;
      try {
        const children = readdirSync(fullPath, { withFileTypes: true });
        hasChildren = children.some((c) => c.isDirectory() && !c.name.startsWith('.'));
      } catch {
        // no access
      }
      return { name: entry.name, path: fullPath, hasChildren };
    });

    return dirs.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
