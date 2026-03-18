import fs from 'fs';

/**
 * Improved JSONL Watcher
 *
 * Uses fs.watch() for instant change notification + fallback polling.
 * Reads only new bytes from file using byte offset tracking.
 */

export interface JsonlWatcherStartOptions {
  skipExisting?: boolean;
  fallbackIntervalMs?: number;
}

export class JsonlWatcher {
  filePath: string;
  lastByteOffset: number;
  private _onEntries: ((entries: unknown[]) => void) | null;
  private _onError: ((err: Error) => void) | null;
  private _fsWatcher: fs.FSWatcher | null;
  private _fallbackInterval: ReturnType<typeof setInterval> | null;
  private _polling: boolean;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lastByteOffset = 0;
    this._onEntries = null;
    this._onError = null;
    this._fsWatcher = null;
    this._fallbackInterval = null;
    this._polling = false;
  }

  start({ skipExisting = true, fallbackIntervalMs = 2000 }: JsonlWatcherStartOptions = {}): void {
    if (skipExisting) {
      try {
        this.lastByteOffset = fs.statSync(this.filePath).size;
      } catch {}
    }

    // Primary: fs.watch() for instant change notification (~1-3ms latency)
    try {
      this._fsWatcher = fs.watch(this.filePath, () => this._poll());
    } catch {
      // fs.watch may fail on some systems — fallback polling handles it
    }

    // Fallback: poll every N ms in case fs.watch misses events
    this._fallbackInterval = setInterval(() => this._poll(), fallbackIntervalMs);

    // Immediate first poll
    this._poll();
  }

  stop(): void {
    if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
  }

  onNewEntries(cb: (entries: unknown[]) => void): void { this._onEntries = cb; }
  onError(cb: (err: Error) => void): void { this._onError = cb; }

  /** Force an immediate poll (used by Stop hook to ensure final entries are read) */
  pollNow(): void { this._poll(); }

  /** Mark current file position — subsequent polls only return content after this point. */
  markCurrentPosition(): void {
    try {
      this.lastByteOffset = fs.statSync(this.filePath).size;
    } catch {}
  }

  private _poll(): void {
    if (this._polling) return; // Prevent re-entrant polls
    this._polling = true;
    try {
      const stats = fs.statSync(this.filePath);

      // Detect truncation (/clear command)
      if (this.lastByteOffset > stats.size) {
        this.lastByteOffset = 0;
      }

      if (stats.size <= this.lastByteOffset) {
        this._polling = false;
        return;
      }

      const newSize = stats.size - this.lastByteOffset;
      const buffer = Buffer.alloc(newSize);
      const fd = fs.openSync(this.filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, newSize, this.lastByteOffset);
      } finally {
        fs.closeSync(fd);
      }

      const text = buffer.toString('utf-8');
      const lines = text.split('\n');
      // Remove trailing empty string from split (artifact of text ending with \n)
      // Without this fix, bytesConsumed overshoots by 1, corrupting subsequent reads.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      const entries: unknown[] = [];
      let bytesConsumed = 0;

      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        if (!line.trim()) {
          bytesConsumed += lineBytes;
          continue;
        }
        try {
          entries.push(JSON.parse(line));
          bytesConsumed += lineBytes;
        } catch {
          // Partial JSON line — don't advance offset, retry next poll
          break;
        }
      }

      this.lastByteOffset += bytesConsumed;

      if (entries.length > 0 && this._onEntries) {
        this._onEntries(entries);
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
