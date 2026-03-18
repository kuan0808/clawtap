import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { extractText, isSystemMessage, extractPlanContent, isNoResponseMessage, extractSubTools } from './message-utils.js';
import type { JsonlEntry, ContentBlock, SubToolBlock } from './message-utils.js';
import type { DirectoryEntry } from '../interface.js';

// --- Constants ---
export const PROJECTS_DIR: string = join(homedir(), '.claude', 'projects');

// --- Helpers ---

interface SessionDirEntry {
  path: string;
  cwd: string | null;
}

interface SessionFileInfo {
  filePath: string;
  sessionId: string;
  cwd: string | null;
  mtime: Date;
}

export interface SessionHeaderResult {
  sessionId: string;
  cwd: string | null;
  lastModified: string;
  firstPrompt: string | null;
  model: string | null;
  version: string | null;
}

export interface GetMessagesResult {
  messages: unknown[];
  lastModified: string | null;
}

export function encodeDirName(dir: string): string {
  return dir.replace(/[\/ .]/g, '-');
}

export async function getSessionDirs(dir?: string): Promise<SessionDirEntry[]> {
  if (dir) {
    const encoded = encodeDirName(dir);
    return [{ path: join(PROJECTS_DIR, encoded), cwd: dir }];
  }
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ path: join(PROJECTS_DIR, e.name), cwd: null }));
  } catch {
    return [];
  }
}

// --- Cross-device continuity ---

// --- Session Listing (file-based) ---

export async function parseSessionHeader(
  filePath: string,
  sessionId: string,
  { cwd, mtime }: { cwd?: string | null; mtime?: Date } = {}
): Promise<SessionHeaderResult> {
  const fileMtime = mtime || (await stat(filePath)).mtime;
  const stream = createReadStream(filePath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let sessionCwd: string | null = null;
  let firstPrompt: string | null = null;
  let sessionModel: string | null = null;
  let sessionVersion: string | null = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry: JsonlEntry = JSON.parse(line);
        if (!sessionCwd && entry.cwd) sessionCwd = entry.cwd as string;
        if (!sessionModel && entry.model) sessionModel = entry.model as string;
        if (!sessionVersion && entry.version) sessionVersion = entry.version as string;
        if (!firstPrompt && entry.type === 'user' && entry.message?.content) {
          firstPrompt = extractText(entry.message.content);
        }
        if (sessionCwd && firstPrompt) break;
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return {
    sessionId,
    cwd: sessionCwd || cwd || null,
    lastModified: fileMtime.toISOString(),
    firstPrompt: firstPrompt ? firstPrompt.slice(0, 200) : null,
    model: sessionModel,
    version: sessionVersion,
  };
}

export async function getSessions(dir?: string, limit?: number): Promise<SessionHeaderResult[]> {
  const sessionDirs = await getSessionDirs(dir);
  const allFiles: SessionFileInfo[] = [];

  for (const { path: dirPath, cwd } of sessionDirs) {
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    const statResults = await Promise.all(
      jsonlFiles.map(async (file): Promise<SessionFileInfo | null> => {
        const filePath = join(dirPath, file);
        const s = await stat(filePath).catch(() => null);
        return s ? { filePath, sessionId: file.replace('.jsonl', ''), cwd, mtime: s.mtime } : null;
      })
    );
    allFiles.push(...statResults.filter((r): r is SessionFileInfo => r !== null));
  }

  // Sort by mtime first (cheap), then only parse top N headers
  allFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const toParse = limit ? allFiles.slice(0, limit) : allFiles;
  const sessions = await Promise.all(
    toParse.map(f => parseSessionHeader(f.filePath, f.sessionId, { cwd: f.cwd, mtime: f.mtime }).catch(() => null))
  );
  return sessions.filter((s): s is SessionHeaderResult => s !== null);
}

export async function getMessages(sessionId: string, dir?: string): Promise<GetMessagesResult> {
  const sessionDirs = await getSessionDirs(dir);
  for (const { path: dirPath } of sessionDirs) {
    const filePath = join(dirPath, `${sessionId}.jsonl`);
    try {
      const messages: unknown[] = [];
      const subToolMap: Map<string, SubToolBlock[]> = new Map(); // parentToolUseId → sub-tool blocks
      const stream = createReadStream(filePath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const entry: JsonlEntry = JSON.parse(line);
            // Track agent sub-tools from progress entries (for SubagentGroup display)
            if (entry.type === 'progress' && entry.data?.type === 'agent_progress') {
              const result = extractSubTools(entry);
              if (result) {
                if (!subToolMap.has(result.parentId)) subToolMap.set(result.parentId, []);
                subToolMap.get(result.parentId)!.push(...result.subTools);
              }
              continue;
            }
            if (!entry.message) continue;
            const content = entry.message.content;
            const text = extractText(content);

            if (entry.type === 'assistant') {
              if (isNoResponseMessage(text)) continue;
              messages.push(entry.message);
            } else if (entry.type === 'user') {
              // Skip messages containing tool results (not needed for display)
              if (Array.isArray(content) && content.some((b: ContentBlock) => b.type === 'tool_result')) continue;
              // Skip system/CLI messages (empty text, system patterns)
              if (isSystemMessage(text, content)) continue;
              // Convert "Implement the following plan:" messages to plan type
              const planBody = extractPlanContent(text);
              if (planBody !== null) {
                messages.push({ role: 'plan', content: planBody });
                continue;
              }
              messages.push(entry.message);
            }
          } catch {}
        }
      } finally {
        rl.close();
        stream.destroy();
      }
      // Inject accumulated sub-tool blocks into their parent Agent messages
      for (const msg of messages) {
        const m = msg as { content?: ContentBlock[] };
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if (block.type !== 'tool_use') continue;
          const subTools = subToolMap.get(block.id!);
          if (subTools && subTools.length > 0) {
            m.content.push(...(subTools as unknown as ContentBlock[]));
            subToolMap.delete(block.id!);
          }
        }
      }
      const fileMtime = await stat(filePath);
      return { messages, lastModified: fileMtime.mtime.toISOString() };
    } catch {
      continue;
    }
  }
  return { messages: [], lastModified: null };
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
