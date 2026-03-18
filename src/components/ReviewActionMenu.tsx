import { useState, useEffect, useCallback } from 'react';
import { AdapterIcon } from './AdapterIcon';
import { BottomSheet } from './BottomSheet';
import { getBrand } from '@/lib/adapter-brands';
import { api } from '@/lib/api';
import type { AdapterConfig, SavedInstruction } from '@/types/adapter';

interface ReviewActionMenuProps {
  visible: boolean;
  adapters: { id: string; displayName: string }[];
  onDirectSend: (adapter: string, model: string) => void;
  onSendWithInstruction: (adapter: string, model: string, instruction: string, isCustom: boolean) => void;
  onClose: () => void;
}

export function ReviewActionMenu({
  visible,
  adapters,
  onDirectSend,
  onSendWithInstruction,
  onClose,
}: ReviewActionMenuProps) {
  const [step, setStep] = useState<'adapter' | 'action'>('adapter');
  const [selectedAdapter, setSelectedAdapter] = useState<string | null>(null);
  const [adapterConfig, setAdapterConfig] = useState<AdapterConfig | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [savedInstructions, setSavedInstructions] = useState<SavedInstruction[]>([]);
  const [customText, setCustomText] = useState('');

  const resetState = useCallback(() => {
    setStep('adapter');
    setSelectedAdapter(null);
    setAdapterConfig(null);
    setSelectedModel('');
    setInstructionsExpanded(false);
    setCustomText('');
  }, []);

  useEffect(() => {
    if (visible) {
      resetState();
      api.getInstructions().then(setSavedInstructions).catch(() => {});
    }
  }, [visible, resetState]);

  useEffect(() => {
    if (!selectedAdapter) return;
    let cancelled = false;
    api.adapterConfig(selectedAdapter).then((config) => {
      if (cancelled) return;
      setAdapterConfig(config);
      if (config.models.length > 0) {
        setSelectedModel(config.models[0].value);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedAdapter]);

  const handleAdapterSelect = useCallback((adapterId: string) => {
    setSelectedAdapter(adapterId);
    setStep('action');
  }, []);

  const handleBack = useCallback(() => {
    resetState();
  }, [resetState]);

  const handleDirectSend = useCallback(() => {
    if (!selectedAdapter) return;
    onDirectSend(selectedAdapter, selectedModel);
    onClose();
  }, [selectedAdapter, selectedModel, onDirectSend, onClose]);

  const handleSavedInstruction = useCallback((instruction: string) => {
    if (!selectedAdapter) return;
    onSendWithInstruction(selectedAdapter, selectedModel, instruction, false);
    onClose();
  }, [selectedAdapter, selectedModel, onSendWithInstruction, onClose]);

  const handleCustomSend = useCallback(() => {
    if (!selectedAdapter || !customText.trim()) return;
    onSendWithInstruction(selectedAdapter, selectedModel, customText.trim(), true);
    onClose();
  }, [selectedAdapter, selectedModel, customText, onSendWithInstruction, onClose]);

  const adapterBrand = selectedAdapter ? getBrand(selectedAdapter) : null;

  return (
    <BottomSheet visible={visible} onClose={onClose} zIndex="z-40" backdropClassName="bg-black/40" className="max-h-[70vh] flex flex-col">

        {step === 'adapter' ? (
          /* Step 1: Adapter Selection */
          <div className="px-4 pb-4 overflow-y-auto">
            <h2 className="text-sm font-medium text-text-dim mb-3">Send to…</h2>
            <div className="space-y-1">
              {adapters.map((adapter) => (
                <button
                  key={adapter.id}
                  onClick={() => handleAdapterSelect(adapter.id)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-white/5 active:bg-white/10 transition-colors"
                  style={{ minHeight: 44 }}
                >
                  <AdapterIcon adapterId={adapter.id} size={20} />
                  <span className="text-sm text-text">{adapter.displayName}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Step 2: Action Selection */
          <div className="px-4 pb-4 overflow-y-auto flex flex-col gap-3">
            {/* Back header */}
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 -ml-1 py-1 text-sm"
              style={{ minHeight: 44 }}
            >
              <span className="text-text-dim">‹</span>
              <span style={{ color: adapterBrand?.color }} className="font-medium">
                {adapterBrand?.displayName}
              </span>
            </button>

            {/* Model selector */}
            {adapterConfig && adapterConfig.models.length > 0 && (
              <div>
                <label className="text-xs text-text-dim mb-1 block">Model</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent appearance-none"
                >
                  {adapterConfig.models.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Direct Send */}
            <button
              onClick={handleDirectSend}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 transition-colors"
              style={{ minHeight: 44 }}
            >
              <span className="text-base">↗</span>
              <span className="text-sm text-text font-medium">Direct Send</span>
            </button>

            {/* With Instructions toggle */}
            <button
              onClick={() => setInstructionsExpanded((prev) => !prev)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 transition-colors"
              style={{ minHeight: 44 }}
            >
              <div className="flex items-center gap-3">
                <span className="text-base">✎</span>
                <span className="text-sm text-text font-medium">With Instructions</span>
              </div>
              <span className="text-xs text-text-dim">
                {instructionsExpanded ? '▲' : '▼'}
              </span>
            </button>

            {/* Expanded instructions */}
            {instructionsExpanded && (
              <div className="space-y-2 pl-1">
                {/* Saved instructions list */}
                {savedInstructions.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleSavedInstruction(item.instruction)}
                    className="w-full text-left px-3 py-2.5 rounded-md hover:bg-white/5 active:bg-white/10 transition-colors"
                    style={{ minHeight: 44 }}
                  >
                    <div className="text-sm text-text">{item.label}</div>
                    <div className="text-xs text-text-dim truncate">{item.instruction}</div>
                  </button>
                ))}

                {/* Divider */}
                <div className="flex items-center gap-2 px-3 py-1">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-text-dim">或輸入新的</span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                {/* Custom text input */}
                <div className="flex gap-2 px-1">
                  <input
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCustomSend();
                    }}
                    placeholder="Your instruction..."
                    className="flex-1 bg-bg border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    autoFocus
                  />
                  <button
                    onClick={handleCustomSend}
                    disabled={!customText.trim()}
                    className="px-3 py-2 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-40 transition-opacity"
                    style={{ minHeight: 44 }}
                  >
                    ↑
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
    </BottomSheet>
  );
}
