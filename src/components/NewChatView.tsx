import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShimmerInput } from './ShimmerInput';
import { AdapterIcon } from './AdapterIcon';
import { getBrand, ADAPTER_BRANDS } from '@/lib/adapter-brands';
import { api } from '@/lib/api';
import { MODELS, PERMISSION_MODES, dirName } from '@/lib/utils';
import { loadAdapterPrefs, saveAdapterPrefs } from '@/lib/adapter-prefs';
import { STORAGE } from '@/lib/storage-keys';

type AdapterConfig = {
  models: { value: string; label: string; contextWindow: number }[];
  permissionModes: { value: string; label: string }[];
  effortLevels: { value: string; label: string }[];
  effortLabel: string;
};

function SettingCard({ label, value, color, onClick }: { label: string; value: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-surface border border-border rounded-md px-3 py-3 flex flex-col items-center gap-1 hover:border-accent/40 transition-colors cursor-pointer"
    >
      <span className="text-[10px] font-medium font-mono text-text-dim uppercase tracking-wider">{label}</span>
      <span className="text-[13px] font-medium font-mono" style={{ color }}>{value}</span>
    </button>
  );
}

export function NewChatView({
  cwd,
  onStartChat,
  onBack,
}: {
  cwd: string;
  onStartChat: (options: { adapter: string; model: string; permissionMode: string; effort: string; prompt: string }) => void;
  onBack: () => void;
}) {
  const [availableAdapters, setAvailableAdapters] = useState<{ id: string; displayName: string; available: boolean }[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState<string>(
    () => localStorage.getItem(STORAGE.ADAPTER) || 'claude'
  );
  const [adapterConfig, setAdapterConfig] = useState<AdapterConfig | null>(null);
  const initPrefs = loadAdapterPrefs(selectedAdapter);
  const [model, setModel] = useState<string>(initPrefs.model);
  const [permissionMode, setPermissionMode] = useState<string>(initPrefs.permissionMode);
  const [effort, setEffort] = useState<string>(initPrefs.effort || 'high');

  const brand = getBrand(selectedAdapter);
  const projectName = dirName(cwd);

  // Fetch available adapters on mount
  useEffect(() => {
    api.adapters().then(setAvailableAdapters).catch(console.error);
  }, []);

  // Fetch adapter config when adapter changes
  useEffect(() => {
    api.adapterConfig(selectedAdapter).then((config) => {
      setAdapterConfig(config);
      const prefs = loadAdapterPrefs(selectedAdapter);
      // If current model is not valid for this adapter, pick the first
      const validModel = config.models.some((m) => m.value === prefs.model);
      if (!validModel && config.models.length > 0) {
        const fallback = config.models[0].value;
        setModel(fallback);
        saveAdapterPrefs(selectedAdapter, { ...prefs, model: fallback });
      }
      // If current effort is not valid for this adapter, pick the first
      if (config.effortLevels.length > 0) {
        const validEffort = config.effortLevels.some((e) => e.value === prefs.effort);
        if (!validEffort) {
          const fallback = config.effortLevels[0].value;
          setEffort(fallback);
          saveAdapterPrefs(selectedAdapter, { ...prefs, effort: fallback });
        }
      }
    }).catch(console.error);
  }, [selectedAdapter]);

  // Switch adapter
  const switchAdapter = useCallback(() => {
    const adapterIds = availableAdapters.filter((a) => a.available).map((a) => a.id);
    if (adapterIds.length <= 1) return;
    const idx = adapterIds.indexOf(selectedAdapter);
    const nextId = adapterIds[(idx + 1) % adapterIds.length];
    setSelectedAdapter(nextId);
    localStorage.setItem(STORAGE.ADAPTER, nextId);
    // Load saved prefs for the new adapter
    const prefs = loadAdapterPrefs(nextId);
    setModel(prefs.model);
    setPermissionMode(prefs.permissionMode);
    setEffort(prefs.effort || 'high');
  }, [availableAdapters, selectedAdapter]);

  // Settings: cycle model
  const models = adapterConfig?.models ?? MODELS;
  const permissionModes = adapterConfig?.permissionModes ?? PERMISSION_MODES;

  const cycleModel = useCallback(() => {
    const idx = models.findIndex((m) => m.value === model);
    const next = models[(idx + 1) % models.length];
    setModel(next.value);
    saveAdapterPrefs(selectedAdapter, { model: next.value, permissionMode, effort });
  }, [models, model, selectedAdapter, permissionMode, effort]);

  const cyclePermission = useCallback(() => {
    const idx = permissionModes.findIndex((m) => m.value === permissionMode);
    const next = permissionModes[(idx + 1) % permissionModes.length];
    setPermissionMode(next.value);
    saveAdapterPrefs(selectedAdapter, { model, permissionMode: next.value, effort });
  }, [permissionModes, permissionMode, selectedAdapter, model, effort]);

  const effortLevels = adapterConfig?.effortLevels ?? [];
  const effortLabel = adapterConfig?.effortLabel ?? 'Effort';

  const cycleEffort = useCallback(() => {
    if (effortLevels.length === 0) return;
    const idx = effortLevels.findIndex((e) => e.value === effort);
    const next = effortLevels[(idx + 1) % effortLevels.length];
    setEffort(next.value);
    saveAdapterPrefs(selectedAdapter, { model, permissionMode, effort: next.value });
  }, [effortLevels, effort, selectedAdapter, model, permissionMode]);

  const effortValue = effortLevels.find((e) => e.value === effort)?.label || effort;

  const modelLabel = models.find((m) => m.value === model)?.label || model;
  const modeLabel = permissionModes.find((m) => m.value === permissionMode)?.label || permissionMode;

  // Other adapters to switch to
  const otherAdapters = availableAdapters.filter((a) => a.available && a.id !== selectedAdapter);

  const handleSend = useCallback((prompt: string) => {
    if (!prompt.trim()) return;
    // Save current prefs
    saveAdapterPrefs(selectedAdapter, { model, permissionMode, effort });
    localStorage.setItem(STORAGE.ADAPTER, selectedAdapter);
    onStartChat({ adapter: selectedAdapter, model, permissionMode, effort, prompt });
  }, [selectedAdapter, model, permissionMode, effort, onStartChat]);

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 safe-top">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <span className="text-sm font-medium text-text truncate">{projectName}</span>
      </div>

      {/* Body — centered content */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-4">
        {/* Hero Icon */}
        <div
          className="w-20 h-20 rounded-xl flex items-center justify-center mb-4"
          style={{
            background: brand.gradient,
            boxShadow: `0 8px 32px ${brand.glow}, 0 0 0 1px ${brand.glow}`,
          }}
        >
          <AdapterIcon adapterId={selectedAdapter} size={44} className="!text-white" />
        </div>

        {/* Adapter name + provider */}
        <h1 className="text-xl font-bold font-mono tracking-wide text-text">{brand.displayName}</h1>
        <p className="text-sm font-mono text-text-dim mt-0.5">by {brand.provider}</p>

        {/* Switch adapter */}
        {otherAdapters.length > 0 && (
          <div className="mt-3 flex items-center gap-1.5 text-sm text-text-secondary">
            <span>Switch to</span>
            {otherAdapters.map((a) => {
              const b = getBrand(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    setSelectedAdapter(a.id);
                    localStorage.setItem(STORAGE.ADAPTER, a.id);
                    const prefs = loadAdapterPrefs(a.id);
                    setModel(prefs.model);
                    setPermissionMode(prefs.permissionMode);
                    setEffort(prefs.effort || 'high');
                  }}
                  className="text-xs font-semibold px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity cursor-pointer"
                  style={{ color: b.color, backgroundColor: b.colorBg }}
                >
                  {b.displayName}
                </button>
              );
            })}
          </div>
        )}

        {/* Settings cards */}
        <div className={`grid ${effortLevels.length > 0 ? 'grid-cols-3' : 'grid-cols-2'} gap-3 mt-8 w-full max-w-sm`}>
          <SettingCard label="Model" value={modelLabel} color={brand.color} onClick={cycleModel} />
          {effortLevels.length > 0 && (
            <SettingCard label={effortLabel} value={effortValue} color={brand.color} onClick={cycleEffort} />
          )}
          <SettingCard label="Permission" value={modeLabel} color={brand.color} onClick={cyclePermission} />
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 px-4 py-2 safe-bottom">
        <ShimmerInput
          onSend={handleSend}
          disabled={false}
          streaming={false}
          interrupted={false}
        />
      </div>
    </div>
  );
}
