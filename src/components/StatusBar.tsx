import { memo, useState, useEffect, useRef } from 'react';
import { cn, MODELS, PERMISSION_MODES } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { getBrand } from '@/lib/adapter-brands';
import { BottomSheet } from './BottomSheet';

export type AdapterConfig = {
  models: { value: string; label: string; contextWindow: number }[];
  permissionModes: { value: string; label: string }[];
  capabilities?: {
    supportsPermissionModes: boolean;
    permissionModeType?: 'cycle' | 'toggle';
  };
} | null;

export type SessionStatus = {
  contextPercent: number | null;
  model: string | null;
  cost: number | null;
};

export const StatusBar = memo(function StatusBar({
  model,
  permissionMode,
  sessionStatus,
  adapterConfig,
  selectedAdapter,
  streaming,
  onModelChange,
  onPermissionModeChange,
}: {
  model: string;
  permissionMode: string;
  sessionStatus: SessionStatus | null;
  adapterConfig?: AdapterConfig;
  selectedAdapter: string;
  streaming?: boolean;
  onModelChange: (m: string) => void;
  onPermissionModeChange: (m: string) => void;
}) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [slowNetwork, setSlowNetwork] = useState(false);

  useEffect(() => {
    const conn = (navigator as any).connection;
    if (!conn) return;
    const check = () => {
      setSlowNetwork(conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g');
    };
    check();
    conn.addEventListener('change', check);
    return () => conn.removeEventListener('change', check);
  }, []);

  const brand = getBrand(selectedAdapter);
  const models = adapterConfig?.models ?? MODELS;
  const permissionModes = adapterConfig?.permissionModes ?? PERMISSION_MODES;

  const modelConfig = models.find((m) => m.value === model);
  const modelLabel = modelConfig?.label || model;
  const modeLabel = permissionModes.find((m) => m.value === permissionMode)?.label
    || (permissionMode === 'plan' ? 'Plan' : permissionMode);

  const contextPercent = sessionStatus?.contextPercent ?? 0;
  const hasContext = contextPercent > 0;
  const contextColor = contextPercent > 80 ? 'text-danger' : contextPercent > 50 ? 'text-warning' : 'text-text-dim';
  const progressVariant = contextPercent > 80 ? 'danger' as const : contextPercent > 50 ? 'warning' as const : 'default' as const;

  const canCycleMode = adapterConfig?.capabilities?.supportsPermissionModes !== false;
  const modeType = adapterConfig?.capabilities?.permissionModeType || 'cycle';

  // For toggle mode: remember the non-plan mode so we can toggle back to it.
  // Can't use loadAdapterPrefs because updatePermissionMode writes 'plan' to prefs.
  const startupModeRef = useRef(permissionMode !== 'plan' ? permissionMode : 'default');
  if (permissionMode !== 'plan') {
    startupModeRef.current = permissionMode;
  }

  const cycleMode = canCycleMode && !streaming ? () => {
    if (modeType === 'toggle') {
      // Codex: toggle between 'plan' and the startup mode
      const nextMode = permissionMode === 'plan' ? startupModeRef.current : 'plan';
      onPermissionModeChange(nextMode);
    } else {
      // Claude: cycle through full array
      const idx = permissionModes.findIndex((m) => m.value === permissionMode);
      const next = permissionModes[(idx + 1) % permissionModes.length];
      onPermissionModeChange(next.value);
    }
  } : undefined;

  return (
    <div className="flex items-center justify-between px-4 py-1.5 text-[11px] text-text-dim font-mono border-t border-border">
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-semibold px-1.5 rounded"
          style={{ color: brand.color, backgroundColor: brand.colorBg }}
        >
          {brand.displayName}
        </span>
        <button
          onClick={() => !streaming && setShowModelPicker(true)}
          className={`font-medium py-1 -my-1 transition-colors ${
            streaming ? 'text-text-dim/50 cursor-default' : 'text-text-secondary hover:text-text cursor-pointer'
          }`}
        >
          {modelLabel}
        </button>
        {slowNetwork && (
          <span className="text-warning text-[10px] font-mono">Slow</span>
        )}
        <span className="text-border">·</span>
        <button
          onClick={cycleMode}
          className={`text-text-dim transition-colors py-1 -my-1 ${
            streaming ? 'text-text-dim/50 cursor-default'
              : canCycleMode ? 'cursor-pointer hover:text-text' : 'cursor-default'
          }`}
        >
          {modeLabel}
        </button>
      </div>
      {hasContext && (
        <div className="flex items-center gap-1.5">
          <Progress value={contextPercent} variant={progressVariant} className="h-1 w-16" />
          <span className={cn(contextColor)}>{contextPercent}%</span>
        </div>
      )}
      <BottomSheet visible={showModelPicker} onClose={() => setShowModelPicker(false)} zIndex="z-40" backdropClassName="bg-black/60" className="p-4 pb-8">
        <div className="text-sm font-medium text-text mb-3">Select Model</div>
        <div className="space-y-1 max-h-[60vh] overflow-y-auto">
          {models.map(m => (
            <button
              key={m.value}
              onClick={() => { onModelChange(m.value); setShowModelPicker(false); }}
              className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                m.value === model
                  ? 'bg-accent/20 text-accent font-medium'
                  : 'text-text-secondary hover:bg-white/5'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
});
