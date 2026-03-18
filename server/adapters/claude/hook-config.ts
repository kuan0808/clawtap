// server/adapters/claude/hook-config.ts
//
// Pure filesystem operations for Claude hook management.
// Zero runtime dependencies — no EventEmitter, no tmux, no sessions.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Individual hook action (command or url based) */
interface HookAction {
  type?: string;
  command?: string;
  url?: string;
  timeout?: number;
}

/** A hook entry within a hook event */
interface HookEntry {
  matcher?: string;
  hooks: HookAction[];
}

/** Hook identifiers for matching our entries */
interface HookIdentifiers {
  portTag: string;
}

/** The structure of Claude's settings.json (partial) */
interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  statusLine?: { type: string; command: string };
  _clawtapOriginalStatusLine?: string;
  [key: string]: unknown;
}

export class ClaudeHookConfig {
  /** Shared between install() wrapper construction and _extractOriginalFromWrapper() */
  private static readonly WRAPPER_TAIL = `fi; printf '%s' "$input" | `;

  port: number | string;
  useHttps: boolean;

  constructor(port?: number | string, useHttps?: boolean) {
    this.port = port || process.env.PORT || 3456;
    if (useHttps !== undefined) {
      this.useHttps = useHttps;
    } else {
      // Auto-detect from cert files
      const clawtapDir = join(homedir(), '.clawtap');
      this.useHttps = existsSync(join(clawtapDir, 'cert.pem')) && existsSync(join(clawtapDir, 'key.pem'));
    }
  }

  /** Install ClawTap hooks into ~/.claude/settings.json */
  install(): void {
    const port = this.port;
    const settingsDir = join(homedir(), '.claude');
    const settingsPath = join(settingsDir, 'settings.json');

    const { portTag } = this._hookIdentifiers();
    const protocol = this.useHttps ? 'https' : 'http';
    const hookUrl = `${protocol}://localhost:${port}/api/hooks/claude`;
    const desiredHooks = this._buildDesiredHooks(hookUrl);
    const statuslineUrl = `${hookUrl}/statusline`;

    try {
      mkdirSync(settingsDir, { recursive: true });
      let existing: ClaudeSettings = {};
      try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings; } catch {}

      // Replace our hooks on every startup (handles HTTP → command upgrade).
      // Preserves other tools' hooks by filtering only ClawTap entries.
      if (!existing.hooks) existing.hooks = {};

      for (const [event, configs] of Object.entries(desiredHooks)) {
        const existingEntries = existing.hooks[event] || [];
        const filtered = existingEntries.filter(entry => !this._isOurHookEntry(entry, portTag));
        existing.hooks[event] = [...filtered, ...configs];
      }

      // Wrap statusLine to also POST to our server (non-blocking).
      // - Has custom statusLine → wrap it (POST + original coexist)
      // - No custom statusLine  → don't touch it, preserve Claude Code built-in
      const existingCmd = existing.statusLine?.command || '';
      if (existingCmd && !existingCmd.includes(`:${port}/api/hooks/claude/statusline`)) {
        existing._clawtapOriginalStatusLine = existingCmd;
        const portCheck = this._portCheckCmd();
        const curlK = this.useHttps ? ' -k' : '';
        const wrapperCmd = `input=$(cat); if ${portCheck}; then printf '%s' "$input" | curl -sf${curlK} -X POST -H 'Content-Type:application/json' -d @- ${statuslineUrl} &>/dev/null & ${ClaudeHookConfig.WRAPPER_TAIL}${existingCmd}`;
        existing.statusLine = { type: 'command', command: wrapperCmd };
        console.log(`[hooks] Wrapped statusLine to POST to ${statuslineUrl}`);
      }

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks] Auto-configured HTTP hooks in ${settingsPath}`);
    } catch (err) {
      console.warn(`[hooks] Failed to auto-configure hooks: ${(err as Error).message}`);
    }
  }

  /**
   * Remove ClawTap hooks from ~/.claude/settings.json.
   * Leaves other user settings intact. Only removes hooks owned by this port.
   */
  uninstall(): void {
    const { portTag } = this._hookIdentifiers();
    const settingsPath = join(homedir(), '.claude', 'settings.json');

    try {
      const existing: ClaudeSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;

      // --- Clean up hooks (independent of statusLine) ---
      if (existing.hooks) {
        const hookKeys = Object.keys(this._buildDesiredHooks(''));
        for (const key of hookKeys) {
          const entries = existing.hooks[key];
          if (!Array.isArray(entries)) continue;

          const filtered = entries.filter(entry => !this._isOurHookEntry(entry, portTag));

          if (filtered.length === 0) {
            delete existing.hooks[key];
          } else {
            existing.hooks[key] = filtered;
          }
        }

        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }

      // --- Restore statusLine (independent of hooks) ---
      // Restore original statusLine: try extraction from wrapper first (most reliable),
      // then fall back to backup field, then delete only if truly no original existed.
      if (existing.statusLine?.command?.includes(portTag)) {
        const original = this._extractOriginalFromWrapper(existing.statusLine.command);
        if (original) {
          existing.statusLine = { type: 'command', command: original };
        } else if (existing._clawtapOriginalStatusLine) {
          existing.statusLine = { type: 'command', command: existing._clawtapOriginalStatusLine };
        } else {
          delete existing.statusLine;
        }
      }
      delete existing._clawtapOriginalStatusLine;

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks] Removed ClawTap hooks from ${settingsPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn(`[hooks] Failed to remove hooks: ${(err as Error).message}`);
    }
  }

  // --- Internal helpers ---

  private _hookIdentifiers(): HookIdentifiers {
    return {
      portTag: `:${this.port}/api/hooks/claude`,
    };
  }

  /** Extract the original statusLine command from our wrapper using WRAPPER_TAIL. */
  private _extractOriginalFromWrapper(cmd: string): string | null {
    const tail = ClaudeHookConfig.WRAPPER_TAIL;
    const idx = cmd.lastIndexOf(tail);
    if (idx < 0) return null;
    const original = cmd.substring(idx + tail.length).trim();
    if (!original || original.includes('/api/hooks/claude')) return null;
    return original;
  }

  private _isOurHookEntry(entry: HookEntry, portTag: string): boolean {
    const hooks = entry.hooks || [];
    return hooks.some(h =>
      (h.url && h.url.includes(portTag)) ||
      (h.command && h.command.includes(portTag))
    );
  }

  private _buildDesiredHooks(hookUrl: string): Record<string, HookEntry[]> {
    // Fire-and-forget: read stdin, background curl, exit immediately.
    // Zero blocking — Claude Code never waits for ClawTap.
    // /dev/tcp check: fails instantly (<1ms) if server isn't listening, avoiding 2s curl timeout
    // --connect-timeout 2: give up if server unreachable
    // --max-time 5: give up if server hangs after accepting connection
    const portCheck = this._portCheckCmd();
    const curlInsecure = this.useHttps ? ' -k' : '';
    const fireAndForget = (endpoint: string): string =>
      `${portCheck} || exit 0; input=$(cat); printf '%s' "$input" | curl -sf${curlInsecure} --connect-timeout 2 --max-time 5 -X POST -H 'Content-Type:application/json' -d @- ${hookUrl}/${endpoint} &>/dev/null &`;
    return {
      SessionStart: [{ hooks: [{ type: 'command', command: fireAndForget('session-start'), timeout: 2 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: fireAndForget('user-prompt-submit'), timeout: 2 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: fireAndForget('pre-tool-use'), timeout: 2 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: fireAndForget('post-tool-use'), timeout: 2 }] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: fireAndForget('post-tool-use-failure'), timeout: 2 }] }],
      Stop: [{ hooks: [{ type: 'command', command: fireAndForget('stop'), timeout: 2 }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: fireAndForget('stop-failure'), timeout: 2 }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: fireAndForget('stop'), timeout: 2 }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: fireAndForget('permission-request'), timeout: 2 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: fireAndForget('session-end'), timeout: 2 }] }],
      PreCompact: [
        { matcher: 'auto', hooks: [{ type: 'command', command: fireAndForget('pre-compact'), timeout: 2 }] },
        { matcher: 'manual', hooks: [{ type: 'command', command: fireAndForget('pre-compact'), timeout: 2 }] },
      ],
      PostCompact: [
        { matcher: 'auto', hooks: [{ type: 'command', command: fireAndForget('post-compact'), timeout: 2 }] },
        { matcher: 'manual', hooks: [{ type: 'command', command: fireAndForget('post-compact'), timeout: 2 }] },
      ],
    };
  }

  private _portCheckCmd(): string {
    return `(echo >/dev/tcp/localhost/${this.port}) 2>/dev/null`;
  }
}
