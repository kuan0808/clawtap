// server/adapters/codex/hook-config.ts
//
// Pure filesystem operations for Codex hook management.
// Zero runtime dependencies — no EventEmitter, no tmux, no sessions.
//
// Key differences from Claude's hook-config:
// - Hooks live in ~/.codex/hooks.json (dedicated file, not mixed with other settings)
// - Only 3 hook events: SessionStart, UserPromptSubmit, Stop
// - No statusLine wrapping (Codex has no statusLine hook)
// - Additionally manages codex_hooks feature flag in ~/.codex/config.toml

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';

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

/** Hook identifiers for matching our entries */
interface HookIdentifiers {
  portTag: string;
  hookPath: string;
}

/** The structure of Codex's hooks.json */
interface CodexHooksFile {
  hooks?: Record<string, HookEntry[]>;
}

export class CodexHookConfig {
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

  /** Install ClawTap hooks into ~/.codex/hooks.json and enable feature flag in config.toml */
  install(): void {
    const port = this.port;
    const codexDir = join(homedir(), '.codex');
    const hooksPath = join(codexDir, 'hooks.json');
    const configTomlPath = join(codexDir, 'config.toml');

    const { portTag, hookPath } = this._hookIdentifiers();
    const protocol = this.useHttps ? 'https' : 'http';
    const hookUrl = `${protocol}://localhost:${port}/api/hooks/codex`;
    const desiredHooks = this._buildDesiredHooks(hookUrl, hookPath);

    try {
      mkdirSync(codexDir, { recursive: true });

      // --- 1. Write hooks.json ---
      let existing: CodexHooksFile = {};
      try { existing = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CodexHooksFile; } catch {}

      if (!existing.hooks) existing.hooks = {};

      for (const [event, configs] of Object.entries(desiredHooks)) {
        const existingEntries = existing.hooks[event] || [];
        const filtered = existingEntries.filter(entry => !this._isOurHookEntry(entry, portTag, hookPath));
        existing.hooks[event] = [...filtered, ...configs];
      }

      writeFileSync(hooksPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:codex] Auto-configured hooks in ${hooksPath}`);

      // --- 2. Enable codex_hooks feature flag in config.toml ---
      this._setFeatureFlag(configTomlPath, true);
    } catch (err) {
      console.warn(`[hooks:codex] Failed to auto-configure hooks: ${(err as Error).message}`);
    }
  }

  /**
   * Remove ClawTap hooks from ~/.codex/hooks.json.
   * Optionally remove the codex_hooks feature flag from config.toml.
   */
  uninstall(): void {
    const { portTag, hookPath } = this._hookIdentifiers();
    const codexDir = join(homedir(), '.codex');
    const hooksPath = join(codexDir, 'hooks.json');
    const configTomlPath = join(codexDir, 'config.toml');

    try {
      const existing: CodexHooksFile = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CodexHooksFile;

      if (existing.hooks) {
        const hookKeys = Object.keys(this._buildDesiredHooks('', ''));
        for (const key of hookKeys) {
          const entries = existing.hooks[key];
          if (!Array.isArray(entries)) continue;

          const filtered = entries.filter(entry => !this._isOurHookEntry(entry, portTag, hookPath));

          if (filtered.length === 0) {
            delete existing.hooks[key];
          } else {
            existing.hooks[key] = filtered;
          }
        }

        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }

      writeFileSync(hooksPath, JSON.stringify(existing, null, 2));
      console.log(`[hooks:codex] Removed ClawTap hooks from ${hooksPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // hooks.json doesn't exist — nothing to clean up
      } else {
        console.warn(`[hooks:codex] Failed to remove hooks: ${(err as Error).message}`);
      }
    }

    // Remove the feature flag
    try {
      this._setFeatureFlag(join(homedir(), '.codex', 'config.toml'), false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[hooks:codex] Failed to update config.toml: ${(err as Error).message}`);
      }
    }
  }

  // --- Internal helpers ---

  private _hookIdentifiers(): HookIdentifiers {
    return {
      portTag: `:${this.port}/api/hooks/codex`,
      hookPath: join(__dirname, '..', '..', '..', 'bin', 'clawtap-hook'),
    };
  }

  private _isOurHookEntry(entry: HookEntry, portTag: string, hookPath: string): boolean {
    const hooks = entry.hooks || [];
    return hooks.some(h =>
      (h.url && h.url.includes(portTag)) ||
      (h.command && (h.command === hookPath || h.command.includes(portTag)))
    );
  }

  private _buildDesiredHooks(hookUrl: string, hookPath: string): Record<string, HookEntry[]> {
    // Fire-and-forget: read stdin, background curl, exit immediately.
    // Zero blocking — Codex never waits for ClawTap.
    // NOTE: No /dev/tcp port check — Codex executes hooks with zsh, which doesn't
    // support /dev/tcp (bash-only). curl's --connect-timeout handles the "not listening" case.
    const curlInsecure = this.useHttps ? ' -k' : '';
    const fireAndForget = (endpoint: string): string =>
      `input=$(cat); printf '%s' "$input" | curl -sf${curlInsecure} --connect-timeout 2 --max-time 5 -X POST -H 'Content-Type:application/json' -d @- ${hookUrl}/${endpoint} &>/dev/null &`;

    return {
      SessionStart: [{ hooks: [{ type: 'command', command: fireAndForget('session-start'), timeout: 2 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: fireAndForget('user-prompt-submit'), timeout: 2 }] }],
      Stop: [{ hooks: [{ type: 'command', command: fireAndForget('stop'), timeout: 2 }] }],
    };
  }

  /**
   * Auto-trust a directory in config.toml so Codex doesn't show an interactive
   * trust prompt that blocks _waitForReady.
   */
  trustDirectory(dirPath: string): void {
    const configPath = join(homedir(), '.codex', 'config.toml');
    let config: Record<string, any> = {};

    try {
      config = parseTOML(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    } catch {
      if (existsSync(configPath)) return; // Corrupted file — don't touch
    }

    if (!config.project) config.project = {};
    const projects = config.project as Record<string, any>;

    // Already trusted
    if (projects[dirPath]?.trust_level === 'trusted') return;

    // Add trust
    projects[dirPath] = { ...(projects[dirPath] || {}), trust_level: 'trusted' };

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, stringifyTOML(config));
  }

  /**
   * Set or remove the codex_hooks feature flag in config.toml.
   *
   * Uses smol-toml parser to safely modify the TOML file without corrupting
   * other sections (e.g., [project."..."] with paths containing special chars).
   */
  private _setFeatureFlag(configPath: string, enable: boolean): void {
    let config: Record<string, any> = {};

    // Parse existing config (if any)
    try {
      const content = readFileSync(configPath, 'utf-8');
      config = parseTOML(content) as Record<string, any>;
    } catch (err) {
      if (existsSync(configPath)) {
        // File exists but has invalid TOML — don't overwrite it
        console.warn(`[hooks:codex] Warning: ${configPath} has invalid TOML, skipping modification`);
        return;
      }
      // File doesn't exist — start fresh
    }

    if (enable) {
      if (!config.features) config.features = {};
      (config.features as Record<string, any>).codex_hooks = true;
    } else {
      if (config.features && typeof config.features === 'object') {
        delete (config.features as Record<string, any>).codex_hooks;
        // Remove empty [features] section
        if (Object.keys(config.features as object).length === 0) {
          delete config.features;
        }
      }
    }

    // Only write if there's content or we're enabling
    if (enable || Object.keys(config).length > 0) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, stringifyTOML(config));
      console.log(`[hooks:codex] ${enable ? 'Enabled' : 'Disabled'} codex_hooks in ${configPath}`);
    }
  }
}
