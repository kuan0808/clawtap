// server/adapters/gemini/hook-config.ts
//
// Pure filesystem operations for Gemini hook management.
// Zero runtime dependencies — no EventEmitter, no tmux, no sessions.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** The structure of Gemini's settings.json (partial) */
interface GeminiSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export class GeminiHookConfig {
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

  /** Install ClawTap hooks into ~/.gemini/settings.json */
  install(): void {
    const port = this.port;
    const settingsDir = join(homedir(), '.gemini');
    const settingsPath = join(settingsDir, 'settings.json');

    const protocol = this.useHttps ? 'https' : 'http';
    const desiredHooks = this._buildDesiredHooks(protocol);

    try {
      mkdirSync(settingsDir, { recursive: true });
      let existing: GeminiSettings = {};
      try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as GeminiSettings; } catch {}

      // Replace our hooks on every startup.
      // Preserves other tools' hooks by filtering only ClawTap entries.
      if (!existing.hooks) existing.hooks = {};

      for (const [event, configs] of Object.entries(desiredHooks)) {
        const existingEntries = existing.hooks[event] || [];
        const filtered = existingEntries.filter(entry => !this._isOurHookEntry(entry));
        existing.hooks[event] = [...filtered, ...configs];
      }

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:gemini] Auto-configured hooks in ${settingsPath}`);
    } catch (err) {
      console.warn(`[hooks:gemini] Failed to auto-configure hooks: ${(err as Error).message}`);
    }
  }

  /**
   * Remove ClawTap hooks from ~/.gemini/settings.json.
   * Leaves other user settings intact. Only removes hooks owned by this port.
   */
  uninstall(): void {
    const settingsPath = join(homedir(), '.gemini', 'settings.json');

    try {
      const existing: GeminiSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as GeminiSettings;

      if (existing.hooks) {
        const hookKeys = Object.keys(this._buildDesiredHooks('http'));
        for (const key of hookKeys) {
          const entries = existing.hooks[key];
          if (!Array.isArray(entries)) continue;

          const filtered = entries.filter(entry => !this._isOurHookEntry(entry));

          if (filtered.length === 0) {
            delete existing.hooks[key];
          } else {
            existing.hooks[key] = filtered;
          }
        }

        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:gemini] Removed ClawTap hooks from ${settingsPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn(`[hooks:gemini] Failed to remove hooks: ${(err as Error).message}`);
    }
  }

  // --- Internal helpers ---

  private _isOurHookEntry(entry: HookEntry): boolean {
    const hooks = entry.hooks || [];
    return hooks.some(h =>
      h.command != null && h.command.includes('bridge.sh') && h.command.includes(String(this.port))
    );
  }

  private _buildDesiredHooks(protocol: string): Record<string, HookEntry[]> {
    const port = this.port;
    const bridgePath = resolve(__dirname, 'bridge.sh');
    // Pass port and protocol as positional args (not env vars).
    // Gemini CLI may use execFile instead of shell, so inline VAR=val doesn't work.
    const mkCmd = (endpoint: string): string =>
      `${bridgePath} ${endpoint} ${port} ${protocol}`;

    // IMPORTANT: Gemini CLI timeout is in MILLISECONDS (not seconds like Claude Code).
    // 5000ms = 5 seconds — enough for bridge.sh to read stdin, printf '{}', and background curl.
    const timeout = 5000;
    return {
      SessionStart:  [{ hooks: [{ type: 'command', command: mkCmd('session-start'),  timeout }] }],
      SessionEnd:    [{ hooks: [{ type: 'command', command: mkCmd('session-end'),    timeout }] }],
      BeforeTool:    [{ matcher: '*', hooks: [{ type: 'command', command: mkCmd('before-tool'),   timeout }] }],
      AfterTool:     [{ matcher: '*', hooks: [{ type: 'command', command: mkCmd('after-tool'),    timeout }] }],
      BeforeAgent:   [{ hooks: [{ type: 'command', command: mkCmd('before-agent'),  timeout }] }],
      AfterAgent:    [{ hooks: [{ type: 'command', command: mkCmd('after-agent'),   timeout }] }],
    };
  }
}
