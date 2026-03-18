// server/adapters/codex/pane-monitor.ts
//
// Polls a tmux pane every 500ms to capture real-time streaming output from
// the Codex CLI running in --no-alt-screen mode.
//
// Detects:
// 1. Streaming response text (new text since last poll)
// 2. Thinking indicators (spinner / processing patterns)
// 3. Approval prompts (Codex waiting for user to approve a command)
//
// Modelled after server/adapters/claude/pane-monitor.ts but with
// Codex-specific regex patterns. Patterns are conservative placeholders
// that will be refined through empirical testing with the actual Codex TUI.

import { EventEmitter } from 'events';

/** Minimal interface for the tmux manager dependency */
interface TmuxCapture {
  capturePane(windowId: string, lines?: number): Promise<string>;
}

/** Thinking indicator detected from pane content */
export interface ThinkingInfo {
  text: string;
  detail: string | null;
}

/**
 * CodexPaneMonitor — polls a tmux pane to detect streaming text,
 * thinking indicators, and approval prompts from the Codex CLI.
 *
 * Events emitted via the injected EventEmitter:
 *   - 'streaming-text'  (sessionId, newText)
 *   - 'thinking'        (sessionId, { text, detail })
 *   - 'approval-prompt' (sessionId, { command, explanation })
 */
export class CodexPaneMonitor {
  private sessionId: string;
  private windowId: string;
  private tmux: TmuxCapture;
  private emitter: EventEmitter;
  private interval: ReturnType<typeof setInterval> | null = null;
  private _lastContent: string = '';
  private _lastResponseText: string = '';

  constructor(
    sessionId: string,
    windowId: string,
    tmuxManager: TmuxCapture,
    emitter: EventEmitter,
  ) {
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.tmux = tmuxManager;
    this.emitter = emitter;
  }

  /** Begin polling the tmux pane at 500ms intervals */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this._poll(), 500);
  }

  /** Stop polling and clear the interval */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Force an immediate poll (useful on hook receipt) */
  async pollNow(): Promise<void> {
    await this._poll();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _poll(): Promise<void> {
    try {
      const content = await this.tmux.capturePane(this.windowId);
      if (content === this._lastContent) return;
      this._lastContent = content;

      // 1. Check for approval prompt (highest priority — blocks everything)
      const approval = detectApprovalPrompt(content);
      if (approval) {
        this.emitter.emit('approval-prompt', this.sessionId, approval);
        return;
      }

      // 2. Check for thinking indicator
      const thinking = detectThinking(content);
      if (thinking) {
        this.emitter.emit('thinking', this.sessionId, thinking);
        return;
      }

      // 3. Extract streaming response text
      const text = extractResponseText(content);
      if (text && text !== this._lastResponseText) {
        this._lastResponseText = text;
        this.emitter.emit('streaming-text', this.sessionId, text);
      }
    } catch {
      // Silently ignore — tmux window may have been killed
    }
  }
}

// =============================================================================
// Detection functions (exported for unit testing)
// =============================================================================

/**
 * Detect Codex thinking/processing indicators.
 *
 * Codex CLI shows various spinner/processing patterns while reasoning.
 * In --no-alt-screen mode these appear as inline text in the pane.
 *
 * Placeholder patterns — will be refined through empirical testing:
 * - "Thinking..." or "Reasoning..." text
 * - Spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ braille spinner set)
 * - "Loading..." or processing indicators
 */
export function detectThinking(content: string): ThinkingInfo | null {
  const lines = content.split('\n');
  // Only check the tail of the pane (last 15 lines)
  const tail = lines.slice(-15);

  for (const line of tail) {
    // Skip completion/summary lines
    if (/completed|finished|done|exited/i.test(line)) continue;

    // Pattern 1: Braille spinner followed by descriptive text
    // e.g. "⠙ Thinking..." or "⠹ Processing..."
    const brailleMatch = line.match(/^\s*([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.+?)\s*$/);
    if (brailleMatch) {
      return { text: brailleMatch[2]!, detail: null };
    }

    // Pattern 2: Explicit "Thinking..." or "Reasoning..." text
    const thinkingMatch = line.match(/^\s*(Thinking|Reasoning|Processing)(\.\.\.)?\s*(?:\((.+?)\))?\s*$/i);
    if (thinkingMatch) {
      return {
        text: `${thinkingMatch[1]}...`,
        detail: thinkingMatch[3] || null,
      };
    }

    // Pattern 3: Dash/line spinner (e.g. "- thinking" or "| working")
    const dashSpinner = line.match(/^\s*[|/\-\\]\s+(thinking|reasoning|working)\b/i);
    if (dashSpinner) {
      return { text: `${dashSpinner[1]}...`, detail: null };
    }
  }

  return null;
}

/**
 * Extract the current streaming response text from pane content.
 *
 * Codex in --no-alt-screen mode writes responses inline. We look for text
 * after the last user input marker and collect lines until we hit a
 * boundary indicator.
 *
 * Placeholder patterns — will be refined through empirical testing:
 * - User input prompt: ">" or "❯" followed by user text
 * - Response boundary: horizontal rules, new prompts, tool output markers
 */
export function extractResponseText(content: string): string {
  const lines = content.split('\n');

  // Find the LAST user prompt line — responses appear after it
  let lastUserPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Codex user prompt patterns (conservative):
    // - ">" or "❯" at start of line followed by user text
    // - "user:" prefix
    if (/^\s*[>❯]\s+\S/.test(line) || /^\s*user:\s/i.test(line)) {
      lastUserPrompt = i;
      break;
    }
  }

  if (lastUserPrompt === -1) return '';

  // Collect response lines after the user prompt
  // Skip the prompt line itself and any blank lines immediately after
  let responseStart = lastUserPrompt + 1;
  while (responseStart < lines.length && lines[responseStart]!.trim() === '') {
    responseStart++;
  }

  if (responseStart >= lines.length) return '';

  const responseLines: string[] = [];
  for (let i = responseStart; i < lines.length; i++) {
    const line = lines[i]!;

    // Stop at boundary markers
    if (
      // Horizontal rules
      /^[─━═\-]{5,}/.test(line.trim()) ||
      // New user prompt
      /^\s*[>❯]\s+\S/.test(line) ||
      // Spinner/thinking indicators (braille set)
      /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/.test(line) ||
      // Tool execution markers (Codex shows commands it wants to run)
      /^\s*\$\s+/.test(line) ||
      // Approval prompt boundary
      /approve|deny|allow|reject/i.test(line) && /\?\s*$/.test(line.trim())
    ) {
      break;
    }
    responseLines.push(line);
  }

  return responseLines.join('\n').trim();
}

/**
 * Detect an approval prompt — Codex waiting for user to approve a command.
 *
 * When Codex wants to execute a command (shell, file write, etc.) and
 * requires approval, it displays the command and waits for input.
 *
 * Placeholder patterns — will be refined through empirical testing:
 * - "Run command?" or "Execute?" prompts
 * - Command display followed by [y/n] or approve/deny prompt
 */
export function detectApprovalPrompt(
  content: string,
): { command: string; explanation: string } | null {
  const lines = content.split('\n');
  // Only check the tail of the pane (last 20 lines) for approval prompts
  const tail = lines.slice(-20);
  const tailText = tail.join('\n');

  // Pattern 1: "Run <command>? [y/n]" style
  const runMatch = tailText.match(
    /(?:Run|Execute|Allow)\s+(?:command\s*)?[:\-]?\s*[`"]?(.+?)[`"]?\s*\?\s*(?:\[([yYnN/]+)\])?\s*$/m,
  );
  if (runMatch) {
    return {
      command: runMatch[1]!.trim(),
      explanation: 'Codex is requesting approval to run a command',
    };
  }

  // Pattern 2: Command displayed in a block followed by approval prompt
  // e.g.:
  //   $ some-command --flag
  //   Approve? (y/n)
  const blockMatch = tailText.match(
    /\$\s+(.+)\n[\s\S]*?(?:Approve|Allow|Confirm)\s*\?\s*(?:\(([yYnN/]+)\))?\s*$/m,
  );
  if (blockMatch) {
    return {
      command: blockMatch[1]!.trim(),
      explanation: 'Codex is requesting approval to execute a command',
    };
  }

  // Pattern 3: Generic approval/permission prompt at the end of pane
  // Catches "Do you want to proceed?" style prompts
  const genericMatch = tail.slice(-5).join('\n').match(
    /(?:proceed|continue|approve|allow)\s*\?\s*(?:\(([yYnN/]+)\))?\s*$/im,
  );
  if (genericMatch) {
    // Try to extract the command from lines above the prompt
    const commandLine = tail.slice(-10, -3).find((l) => /^\s*\$\s+\S/.test(l));
    return {
      command: commandLine ? commandLine.replace(/^\s*\$\s+/, '').trim() : '(unknown)',
      explanation: 'Codex is requesting approval to proceed',
    };
  }

  return null;
}
