import { STORAGE } from './storage-keys';

export type AdapterPrefs = { model: string; permissionMode: string; effort?: string };

export function loadAdapterPrefs(adapterId: string): AdapterPrefs {
  try {
    const raw = localStorage.getItem(STORAGE.adapterPrefs(adapterId));
    if (raw) return JSON.parse(raw);
  } catch {}
  // Defaults per adapter
  if (adapterId === 'claude') return { model: 'opus[1m]', permissionMode: 'default', effort: 'high' };
  if (adapterId === 'codex') return { model: 'gpt-5.4', permissionMode: 'default', effort: 'high' };
  return { model: '', permissionMode: 'default', effort: 'high' };
}

export function saveAdapterPrefs(adapterId: string, prefs: AdapterPrefs): void {
  localStorage.setItem(STORAGE.adapterPrefs(adapterId), JSON.stringify(prefs));
}

export function patchAdapterPrefs(adapterId: string, patch: Partial<AdapterPrefs>): void {
  const existing = loadAdapterPrefs(adapterId);
  saveAdapterPrefs(adapterId, { ...existing, ...patch });
}
