// server/adapters/init.ts
import { register, getAdapterConfig } from './registry.js';

const LOADERS: Record<string, () => Promise<any>> = {
  claude: () => import('./claude/index.js').then(m => m.ClaudeAdapter),
  codex: () => import('./codex/index.js').then(m => m.CodexAdapter),
  gemini: () => import('./gemini/index.js').then(m => m.GeminiAdapter),
};

const { enabledAdapters } = getAdapterConfig();

for (const id of enabledAdapters) {
  const loader = LOADERS[id];
  if (!loader) { console.warn(`[init] Unknown adapter: ${id}`); continue; }
  try {
    const AdapterClass = await loader();
    register(AdapterClass);
  } catch (err) {
    console.warn(`[init] Failed to load adapter ${id}: ${(err as Error).message}`);
  }
}
