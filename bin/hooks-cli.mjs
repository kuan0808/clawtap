#!/usr/bin/env node
// Standalone hook management — no server needed.
// Usage: node hooks-cli.mjs install|uninstall [adapter]
//   adapter: claude, codex, gemini (optional — defaults to all)
import { ClaudeHookConfig } from '../server/adapters/claude/hook-config.js';
import { CodexHookConfig } from '../server/adapters/codex/hook-config.js';
import { GeminiHookConfig } from '../server/adapters/gemini/hook-config.js';

const cmd = process.argv[2];
const adapterArg = process.argv[3] || null; // optional: claude, codex, gemini

if (!cmd || !['install', 'uninstall'].includes(cmd)) {
  console.error('Usage: hooks-cli.mjs install|uninstall [claude|codex|gemini]');
  process.exit(1);
}

if (adapterArg && !['claude', 'codex', 'gemini'].includes(adapterArg)) {
  console.error(`Unknown adapter: ${adapterArg}. Use: claude, codex, gemini`);
  process.exit(1);
}

const adapters = {
  claude: new ClaudeHookConfig(),
  codex: new CodexHookConfig(),
  gemini: new GeminiHookConfig(),
};

// If adapter specified, only operate on that one; otherwise all
const targets = adapterArg ? { [adapterArg]: adapters[adapterArg] } : adapters;

for (const [name, hook] of Object.entries(targets)) {
  hook[cmd]();
}
