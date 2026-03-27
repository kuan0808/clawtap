import { useState, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { loadAdapterPrefs, patchAdapterPrefs } from '@/lib/adapter-prefs';
import { getBrand } from '@/lib/adapter-brands';
import { AdapterIcon } from './AdapterIcon';
import type { AdapterConfig } from '@/types/adapter';

export function AdapterSettingsSection({ adapter, onBack }: { adapter: string; onBack: () => void }) {
  const [config, setConfig] = useState<AdapterConfig | null>(null);
  const [prefs, setPrefs] = useState(() => loadAdapterPrefs(adapter));
  const [error, setError] = useState<string | null>(null);

  const brand = getBrand(adapter);

  useEffect(() => {
    let cancelled = false;
    api.adapterConfig(adapter)
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? 'Failed to load config');
      });
    return () => { cancelled = true; };
  }, [adapter]);

  function handleChange(field: 'model' | 'permissionMode' | 'effort', value: string) {
    const updated = { ...prefs, [field]: value };
    setPrefs(updated);
    patchAdapterPrefs(adapter, { [field]: value });
  }

  const selectClass = 'bg-surface border border-border rounded-md text-text px-3 py-2 w-full appearance-none outline-none focus:border-accent font-mono';
  const labelClass = 'text-text-dim text-xs uppercase tracking-wider mb-1.5 font-mono';

  return (
    <div className="flex flex-col h-full bg-bg">
      <div className="flex items-center px-4 py-3 border-b border-border gap-2 safe-top">
        <button onClick={onBack} className="text-text-dim hover:text-text"><ChevronLeft className="w-5 h-5" /></button>
        <AdapterIcon adapterId={adapter} size={20} />
        <span className="font-medium text-text font-mono tracking-wide">{brand.displayName} Settings</span>
      </div>

      {error && (
        <div className="px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      {!config && !error && (
        <div className="flex-1 flex items-center justify-center text-text-dim text-sm">Loading…</div>
      )}

      {config && (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <div>
            <label className={labelClass}>Model</label>
            <select
              className={selectClass}
              value={prefs.model}
              onChange={(e) => handleChange('model', e.target.value)}
            >
              {config.models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Permission Mode</label>
            <select
              className={selectClass}
              value={prefs.permissionMode}
              onChange={(e) => handleChange('permissionMode', e.target.value)}
            >
              {config.permissionModes.map((pm) => (
                <option key={pm.value} value={pm.value}>{pm.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>{config.effortLabel}</label>
            <select
              className={selectClass}
              value={prefs.effort}
              onChange={(e) => handleChange('effort', e.target.value)}
            >
              {config.effortLevels.map((el) => (
                <option key={el.value} value={el.value}>{el.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
