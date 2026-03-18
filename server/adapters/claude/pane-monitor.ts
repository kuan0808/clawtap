import { tmuxManager } from '../shared/tmux-manager.js';

/** Thinking indicator detected from pane content */
export interface ThinkingInfo {
  text: string;
  detail: string | null;
}

/**
 * Simplified PaneMonitor — only detects:
 * 1. Thinking indicator (spinner + verb)
 * 2. Streaming response text (text after ⏺ marker)
 *
 * Permission mode detection removed — handled by syncPermissionMode() in
 * tmux-adapter via hook body's permission_mode field (including statusline).
 * Permission, question, and idle detection handled by HTTP hooks
 * (PreToolUse, PostToolUse, PermissionRequest, Stop).
 */
export class PaneMonitor {
  windowId: string;
  lastContent: string;
  interval: ReturnType<typeof setInterval> | null;
  private _lastResponseText: string;
  private _onThinking: ((thinking: ThinkingInfo) => void) | null;
  private _onStreamingText: ((text: string) => void) | null;

  constructor(windowId: string) {
    this.windowId = windowId;
    this.lastContent = '';
    this.interval = null;
    this._lastResponseText = '';
    this._onThinking = null;
    this._onStreamingText = null;
  }

  start(): void {
    this.interval = setInterval(async () => {
      try {
        const content = await tmuxManager.capturePane(this.windowId);
        if (content === this.lastContent) return;
        this.lastContent = content;

        // 1. Check thinking (spinner in status area)
        const thinking = detectThinking(content);
        if (thinking && this._onThinking) {
          this._onThinking(thinking);
        }

        // 2. Extract streaming response text
        if (this._onStreamingText && !thinking) {
          const text = extractResponseText(content);
          if (text && text !== this._lastResponseText) {
            this._lastResponseText = text;
            this._onStreamingText(text);
          }
        }
      } catch (err) {
        // Silently ignore — window may have been killed
      }
    }, 500);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  onThinking(cb: (thinking: ThinkingInfo) => void): void { this._onThinking = cb; }
  onStreamingText(cb: (text: string) => void): void { this._onStreamingText = cb; }
}

// --- Detection functions ---

export function detectThinking(content: string): ThinkingInfo | null {
  const lines = content.split('\n');
  const tail = lines.slice(-15);
  for (const line of tail) {
    // Match: spinner char + word ending in "…", with optional (detail)
    // But NOT "Worked for" (completion summary)
    if (/Worked for|completed|Done/i.test(line)) continue;
    const match = line.match(/^\s*([✶✻·✽✳✢])\s+(\S+…)\s*(?:\((.+?)\))?\s*$/);
    if (match) {
      return { text: match[2]!, detail: match[3] || null };
    }
  }
  return null;
}

export function extractResponseText(content: string): string {
  const lines = content.split('\n');

  // Find the LAST user prompt (❯ with text) — only look for responses AFTER it
  let lastUserPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*❯\s+\S/.test(lines[i]!)) {
      lastUserPrompt = i;
      break;
    }
  }

  // Find the response ⏺ AFTER the last user prompt
  let lastResponseStart = -1;
  const searchStart = lastUserPrompt >= 0 ? lastUserPrompt : 0;
  for (let i = lines.length - 1; i >= searchStart; i--) {
    const line = lines[i]!;
    // Skip tool calls: ⏺ CapitalWord( or ⏺ Read/Write N file
    if (/^\s*⏺\s+[A-Z]\w*[\(]/.test(line)) continue;
    if (/^\s*⏺\s+[A-Z]\w+\s+\d+\s+file/.test(line)) continue;
    if (/^\s*⏺\s+/.test(line)) {
      lastResponseStart = i;
      break;
    }
  }

  if (lastResponseStart === -1) return '';

  const responseLines = [lines[lastResponseStart]!.replace(/^\s*⏺\s?/, '')];
  for (let i = lastResponseStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[─━═]{5,}/.test(line.trim()) ||
        /^\s*❯/.test(line) ||
        /^\s*⎿/.test(line) ||
        /^\s*⏺/.test(line) ||
        /^\s*[✶✻·✽✳✢]\s+/.test(line)) {
      break;
    }
    responseLines.push(line);
  }

  return responseLines.join('\n').trim();
}
