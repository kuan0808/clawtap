/** Centralized localStorage key constants. All keys use the `clawtap:` prefix. */
export const STORAGE = {
  TOKEN: 'clawtap:token',
  ADAPTER: 'clawtap:adapter',
  PROJECT_DIR: 'clawtap:projectDir',
  DRAFT: 'clawtap:draft',
  INSTALL_DISMISSED: 'clawtap:install-dismissed',
  SESSIONS_TAB: 'clawtap:sessionsTab',
  PUSH_PROMPTED: 'clawtap:push-prompted',
  adapterPrefs: (id: string) => `clawtap:adapterPrefs:${id}` as const,
} as const;

/** One-time migration from old key names. Runs once before app mount. */
export function migrateStorageKeys(): void {
  // Rename simple keys
  for (const [oldKey, newKey] of [
    ['token', STORAGE.TOKEN],
    ['selectedProjectDir', STORAGE.PROJECT_DIR],
  ] as const) {
    const val = localStorage.getItem(oldKey);
    if (val !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, val);
      localStorage.removeItem(oldKey);
    }
  }

  // Migrate old global model/permissionMode/effort into per-adapter prefs
  // Check both old bare keys AND clawtap:-prefixed keys (from intermediate migration)
  const oldModel = localStorage.getItem('selectedModel') || localStorage.getItem('clawtap:model');
  const oldMode = localStorage.getItem('permissionMode') || localStorage.getItem('clawtap:permissionMode');
  const oldEffort = localStorage.getItem('effort') || localStorage.getItem('clawtap:effort');
  if (oldModel || oldMode || oldEffort) {
    const adapter = localStorage.getItem(STORAGE.ADAPTER) || 'claude';
    const prefsKey = STORAGE.adapterPrefs(adapter);
    let prefs: Record<string, string> = {};
    try { prefs = JSON.parse(localStorage.getItem(prefsKey) || '{}'); } catch {}
    if (oldModel && !prefs.model) prefs.model = oldModel;
    if (oldMode && !prefs.permissionMode) prefs.permissionMode = oldMode;
    if (oldEffort && !prefs.effort) prefs.effort = oldEffort;
    localStorage.setItem(prefsKey, JSON.stringify(prefs));
    localStorage.removeItem('selectedModel');
    localStorage.removeItem('permissionMode');
    localStorage.removeItem('effort');
    localStorage.removeItem('clawtap:model');
    localStorage.removeItem('clawtap:permissionMode');
    localStorage.removeItem('clawtap:effort');
  }
}
