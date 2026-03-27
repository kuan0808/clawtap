// server/adapters/registry.ts
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Express } from 'express';
import type { IAdapter } from './interface.js';
import type { AdapterInfo } from '../types/adapter.js';

/** Constructor type for adapter classes that extend IAdapter */
interface AdapterConstructor {
  new (): IAdapter;
  id: string;
  displayName: string;
  command: string;
}

const configPath = path.join(os.homedir(), '.clawtap', 'config.json');
let userConfig: { defaultAdapter?: string; adapters?: Record<string, { enabled: boolean }> } = {};
try { userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
export const DEFAULT_ADAPTER: string = userConfig.defaultAdapter || 'claude';

/** Return adapter config parsed from ~/.clawtap/config.json */
export function getAdapterConfig(): { defaultAdapter: string; enabledAdapters: string[] } {
  // If no adapters config, enable all known adapters by default.
  // Registry's listAvailable() will check `which <command>` for actual availability.
  const enabledAdapters = userConfig.adapters
    ? Object.entries(userConfig.adapters).filter(([, v]) => v.enabled).map(([k]) => k)
    : ['claude', 'codex', 'gemini'];
  return { defaultAdapter: DEFAULT_ADAPTER, enabledAdapters };
}

const adapters: Map<string, IAdapter> = new Map(); // id → adapter instance
let cachedAvailable: AdapterInfo[] | null = null; // cached result of listAvailable()

export function register(AdapterClass: AdapterConstructor): IAdapter {
  const instance = new AdapterClass();
  adapters.set(AdapterClass.id, instance);
  cachedAvailable = null; // invalidate cache
  return instance;
}

export function get(id: string): IAdapter | undefined {
  return adapters.get(id);
}

export function getDefault(): IAdapter | null {
  return adapters.get(DEFAULT_ADAPTER) || adapters.values().next().value || null;
}

export function listAvailable(): AdapterInfo[] {
  if (cachedAvailable) return cachedAvailable;
  cachedAvailable = [...adapters.values()].map(adapter => {
    const Cls = adapter.constructor as unknown as AdapterConstructor;
    let available = false;
    try {
      execFileSync('which', [Cls.command], { stdio: 'ignore' });
      available = true;
    } catch {}
    return {
      id: Cls.id,
      displayName: Cls.displayName,
      available,
      capabilities: adapter.getCapabilities(),
    };
  });
  return cachedAvailable;
}

export function initAll(app: Express): Map<string, IAdapter> {
  for (const [, adapter] of adapters) {
    adapter.setup(app);
  }
  listAvailable(); // Pre-cache — sync execFileSync runs once at startup, not per-request
  return adapters;
}

/** Install hooks with confirmed port (called after server.listen succeeds) */
export function installAllHooks(port: number | string): void {
  for (const [, adapter] of adapters) {
    adapter.setHookPort(port);
    adapter.installHooks();
  }
}

export function getAll(): Map<string, IAdapter> {
  return adapters;
}

export async function cleanupAll(): Promise<void> {
  for (const [, adapter] of adapters) {
    await adapter.cleanup();
  }
}
