// server/adapters/gemini/pane-monitor.ts
//
// Polls a tmux pane every 500ms to capture real-time streaming output from
// the Gemini CLI.
//
// Detects:
// 1. Streaming response text (new text since last poll)
// 2. Thinking indicators (spinner / processing patterns)
//
// Note: Gemini already provides thinking content in JSON (thoughts[]), so
// pane-level thinking detection is supplementary — it provides real-time
// feedback before the JSON response is written to disk.
//
// Modelled after server/adapters/codex/pane-monitor.ts but with
// Gemini-specific regex patterns. Patterns are conservative placeholders
// that will be refined through empirical testing with the actual Gemini CLI.

import { EventEmitter } from 'events';
import { InteractivePrompt } from '../../types/messages.js';

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

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
 * GeminiPaneMonitor — polls a tmux pane to detect streaming text and
 * thinking indicators from the Gemini CLI.
 *
 * Events emitted via the injected EventEmitter:
 *   - 'streaming-text'  (sessionId, newText)
 *   - 'thinking'        (sessionId, { text, detail })
 */
export class GeminiPaneMonitor {
  private sessionId: string;
  private windowId: string;
  private tmux: TmuxCapture;
  private emitter: EventEmitter;
  private interval: ReturnType<typeof setInterval> | null = null;
  private _lastContent: string = '';
  private _lastResponseText: string = '';
  private lastPromptId: string | null = null;

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

      const lines = content.split('\n');

      // 0. Check for interactive prompt (highest priority)
      const prompt = this._detectPrompt(content, lines);
      if (prompt) {
        if (prompt.requestId !== this.lastPromptId) {
          this.lastPromptId = prompt.requestId;
          this.emitter.emit('interactive-prompt', this.sessionId, prompt);
        }
        return; // Don't process streaming while prompt is showing
      } else if (this.lastPromptId) {
        this.lastPromptId = null;
      }

      // 1. Check for thinking indicator
      const thinking = detectThinking(content);
      if (thinking) {
        this.emitter.emit('thinking', this.sessionId, thinking);
        return;
      }

      // 2. Extract streaming response text
      const text = extractResponseText(content);
      if (text && text !== this._lastResponseText) {
        this._lastResponseText = text;
        this.emitter.emit('streaming-text', this.sessionId, text);
      }
    } catch {
      // Silently ignore — tmux window may have been killed
    }
  }

  /**
   * Detect an interactive prompt in the Gemini CLI pane content.
   * Returns an InteractivePrompt if one is detected, null otherwise.
   */
  private _detectPrompt(content: string, _lines: string[]): InteractivePrompt | null {
    // Tool Confirmation: "Action Required" with numbered options
    if (content.includes('Action Required') && /●\s+\d+\./.test(content)) {
      const description = this._extractBetween(content, 'Action Required', '●');
      const options = this._parseNumberedOptions(content);
      return {
        requestId: `gemini-perm-${simpleHash(description)}`,
        promptType: 'permission',
        title: 'Action Required',
        description: description.trim(),
        options,
      };
    }

    // Plan Approval: "Approval" with "Yes" and "feedback"
    if (content.includes('Approval') && /Yes/.test(content) && /feedback/i.test(content)) {
      const description = this._extractBetween(content, 'Approval', '●');
      const options = this._parseNumberedOptions(content);
      return {
        requestId: `gemini-plan-${simpleHash(description)}`,
        promptType: 'plan',
        title: 'Plan Approval',
        description: description.trim(),
        options,
        textInput: { placeholder: 'Provide feedback...' },
      };
    }

    // AskUser: "Answer Questions"
    if (content.includes('Answer Questions')) {
      const description = this._extractBetween(content, 'Answer Questions', '●');
      const options = this._parseNumberedOptions(content);
      if (options.length > 0) {
        return {
          requestId: `gemini-ask-${simpleHash(description)}`,
          promptType: 'question',
          title: 'Answer Questions',
          description: description.trim(),
          options,
        };
      }
      return {
        requestId: `gemini-ask-${simpleHash(description)}`,
        promptType: 'question',
        title: 'Answer Questions',
        description: description.trim(),
        textInput: { placeholder: 'Type your answer...' },
      };
    }

    // Loop Detection: "potential loop was detected"
    if (content.includes('potential loop was detected')) {
      const options = this._parseNumberedOptions(content);
      return {
        requestId: `gemini-loop-${simpleHash('loop-detected')}`,
        promptType: 'loop-detected',
        title: 'Loop Detected',
        description: 'A potential loop was detected.',
        options,
      };
    }

    return null;
  }

  /**
   * Parse numbered options from Gemini CLI content.
   * Matches patterns like "● 1. Allow this action" or "1. Allow this action".
   * Returns 0-based index values.
   */
  private _parseNumberedOptions(content: string): { value: string; label: string }[] {
    const results: { value: string; label: string }[] = [];
    const regex = /(?:●\s+)?(\d+)\.\s+(.+?)(?:\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const index = parseInt(match[1]!, 10);
      results.push({ value: String(index - 1), label: match[2]!.trim() });
    }
    return results;
  }

  /**
   * Extract text between two markers in the content.
   */
  private _extractBetween(content: string, start: string, end: string): string {
    const startIdx = content.indexOf(start);
    if (startIdx === -1) return '';
    const afterStart = startIdx + start.length;
    const endIdx = content.indexOf(end, afterStart);
    if (endIdx === -1) return content.slice(afterStart).trim();
    return content.slice(afterStart, endIdx).trim();
  }
}

// =============================================================================
// Detection functions (exported for unit testing)
// =============================================================================

/**
 * Detect Gemini thinking/processing indicators.
 *
 * Gemini CLI shows various spinner/processing patterns while reasoning.
 * In non-alt-screen mode these appear as inline text in the pane.
 *
 * Placeholder patterns — will be refined through empirical testing:
 * - "Thinking..." text (Gemini's native thinking label)
 * - Spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ braille spinner set)
 * - "Generating..." or processing indicators
 */
export function detectThinking(content: string): ThinkingInfo | null {
  const lines = content.split('\n');
  // Only check the tail of the pane (last 15 lines)
  const tail = lines.slice(-15);

  for (const line of tail) {
    // Skip completion/summary lines
    if (/completed|finished|done|exited/i.test(line)) continue;

    // Pattern 1: Braille spinner followed by descriptive text
    // e.g. "⠙ Thinking..." or "⠹ Generating..."
    const brailleMatch = line.match(/^\s*([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.+?)\s*$/);
    if (brailleMatch) {
      return { text: brailleMatch[2]!, detail: null };
    }

    // Pattern 2: Explicit "Thinking..." or "Generating..." text
    // Gemini CLI commonly shows "Thinking..." during reasoning
    const thinkingMatch = line.match(
      /^\s*(Thinking|Generating|Processing|Working)(\.\.\.)?\s*(?:\((.+?)\))?\s*$/i,
    );
    if (thinkingMatch) {
      return {
        text: `${thinkingMatch[1]}...`,
        detail: thinkingMatch[3] || null,
      };
    }

    // Pattern 3: Braille spinner on its own (Gemini may render bare spinner)
    const bareSpinner = line.match(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*$/);
    if (bareSpinner) {
      return { text: 'Thinking...', detail: null };
    }
  }

  return null;
}

/**
 * Extract the current streaming response text from pane content.
 *
 * Gemini CLI writes responses inline. We look for text after the last
 * user input marker and collect lines until we hit a boundary indicator.
 *
 * Placeholder patterns — will be refined through empirical testing:
 * - User input prompt: ">" or "❯" followed by user text
 * - Response boundary: horizontal rules, new prompts, spinner indicators
 */
export function extractResponseText(content: string): string {
  const lines = content.split('\n');

  // Find the LAST user prompt line — responses appear after it
  let lastUserPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Gemini user prompt patterns (conservative):
    // - ">" or "❯" at start of line followed by user text
    // - "user:" prefix
    if (/^\s*[>*❯]\s+\S/.test(line) || /^\s*user:\s/i.test(line)) {
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
      /^\s*[>*❯]\s+\S/.test(line) ||
      // Spinner/thinking indicators (braille set)
      /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/.test(line)
    ) {
      break;
    }
    responseLines.push(line);
  }

  return responseLines.join('\n').trim();
}
