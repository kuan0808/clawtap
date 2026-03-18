import fs from 'fs';

/**
 * JSON Watcher for Gemini CLI session files.
 *
 * Gemini CLI stores sessions as single JSON files that are rewritten entirely
 * on each update (unlike Claude/Codex JSONL files that are append-only).
 * Byte-offset tracking does not work here — instead we track message count
 * and last message ID to detect and emit only new messages.
 *
 * Uses fs.watch() for instant change notification + fallback polling + debounce.
 */

export interface GeminiSessionMessage {
  id: string;
  type: 'user' | 'gemini' | 'error' | 'info';
  content: Array<{ text: string }> | string;
  timestamp?: string;
  thoughts?: unknown[];
  tokens?: Record<string, unknown>;
  model?: string;
  toolCalls?: unknown[];
}

export interface JsonWatcherStartOptions {
  skipExisting?: boolean;
  fallbackIntervalMs?: number;
  debounceMs?: number;
}

const SIZE_WARNING_BYTES = 2 * 1024 * 1024; // 2MB

export class JsonWatcher {
  filePath: string;
  private _lastMessageCount: number;
  private _lastMessageId: string | null;
  private _lastFileSize: number;
  private _onMessages: ((messages: GeminiSessionMessage[]) => void) | null;
  private _onError: ((err: Error) => void) | null;
  private _fsWatcher: fs.FSWatcher | null;
  private _fallbackInterval: ReturnType<typeof setInterval> | null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null;
  private _debounceMs: number;
  private _polling: boolean;

  constructor(filePath: string) {
    this.filePath = filePath;
    this._lastMessageCount = 0;
    this._lastMessageId = null;
    this._lastFileSize = 0;
    this._onMessages = null;
    this._onError = null;
    this._fsWatcher = null;
    this._fallbackInterval = null;
    this._debounceTimer = null;
    this._debounceMs = 50;
    this._polling = false;
  }

  start({ skipExisting = true, fallbackIntervalMs = 2000, debounceMs = 50 }: JsonWatcherStartOptions = {}): void {
    this._debounceMs = debounceMs;

    if (skipExisting) {
      try {
        const stats = fs.statSync(this.filePath);
        this._lastFileSize = stats.size;
        // Read existing messages to set baseline counts without emitting them
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as { messages?: GeminiSessionMessage[] };
        const messages = parsed.messages ?? [];
        this._lastMessageCount = messages.length;
        this._lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
      } catch {
        // File may not exist yet — that's fine
      }
    }

    // Primary: fs.watch() for instant change notification (~1-3ms latency)
    try {
      this._fsWatcher = fs.watch(this.filePath, () => this._schedulePoll());
    } catch {
      // fs.watch may fail on some systems — fallback polling handles it
    }

    // Fallback: poll every N ms in case fs.watch misses events
    this._fallbackInterval = setInterval(() => this._poll(), fallbackIntervalMs);

    // Immediate first poll (only meaningful when skipExisting = false)
    if (!skipExisting) {
      this._poll();
    }
  }

  stop(): void {
    if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  onNewMessages(cb: (messages: GeminiSessionMessage[]) => void): void { this._onMessages = cb; }
  onError(cb: (err: Error) => void): void { this._onError = cb; }

  /** Force an immediate poll (used by Stop hook to ensure final messages are read) */
  pollNow(): void { this._poll(); }

  /** Mark current file position — subsequent polls only return messages after current state. */
  markCurrentPosition(): void {
    try {
      const stats = fs.statSync(this.filePath);
      this._lastFileSize = stats.size;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { messages?: GeminiSessionMessage[] };
      const messages = parsed.messages ?? [];
      this._lastMessageCount = messages.length;
      this._lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
    } catch {}
  }

  private _schedulePoll(): void {
    // Debounce: coalesce rapid rewrites within debounceMs window
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._poll();
    }, this._debounceMs);
  }

  private _poll(): void {
    if (this._polling) return; // Prevent re-entrant polls
    this._polling = true;
    try {
      const stats = fs.statSync(this.filePath);

      // File size guard: skip if unchanged (filters false-positive fs.watch events)
      if (stats.size === this._lastFileSize) {
        this._polling = false;
        return;
      }

      if (stats.size > SIZE_WARNING_BYTES) {
        console.warn(`[JsonWatcher] File exceeds 2MB (${stats.size} bytes): ${this.filePath}`);
      }

      this._lastFileSize = stats.size;

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { messages?: GeminiSessionMessage[] };
      const messages = parsed.messages ?? [];

      if (messages.length <= this._lastMessageCount) {
        // No new messages (or messages were deleted — reset baseline)
        if (messages.length < this._lastMessageCount) {
          this._lastMessageCount = messages.length;
          this._lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
        }
        this._polling = false;
        return;
      }

      // Verify continuity: check that the last known message still exists at its index
      if (this._lastMessageId !== null && this._lastMessageCount > 0) {
        const anchorMsg = messages[this._lastMessageCount - 1];
        if (!anchorMsg || anchorMsg.id !== this._lastMessageId) {
          // Message history was modified — reset baseline to current state without emitting
          this._lastMessageCount = messages.length;
          this._lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
          this._polling = false;
          return;
        }
      }

      // Extract new messages starting from last known count
      const newMessages = messages.slice(this._lastMessageCount);

      // Advance position
      this._lastMessageCount = messages.length;
      this._lastMessageId = messages[messages.length - 1].id;

      if (newMessages.length > 0 && this._onMessages) {
        this._onMessages(newMessages);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && this._onError) {
        this._onError(err as Error);
      }
    } finally {
      this._polling = false;
    }
  }
}
