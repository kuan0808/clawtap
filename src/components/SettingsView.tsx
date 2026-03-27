import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ClipboardList, Bell, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { AdapterIcon } from './AdapterIcon';
import { SavedInstructionsView } from './SavedInstructionsView';
import { AdapterSettingsSection } from './AdapterSettingsSection';
import { usePushNotifications } from '@/hooks/usePushNotifications';

interface Adapter {
  id: string;
  displayName: string;
  available: boolean;
}

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [subView, setSubView] = useState<'main' | 'instructions' | string>('main');
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [version, setVersion] = useState<string>('');
  const { supported, subscribed, subscribe, unsubscribe } = usePushNotifications();
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    api.adapters().then(setAdapters).catch(() => {});
    fetch('/health')
      .then(r => r.json())
      .then((data: { version: string }) => setVersion(data.version))
      .catch(() => {});
  }, []);

  if (subView === 'instructions') {
    return <SavedInstructionsView onBack={() => setSubView('main')} />;
  }

  const matchedAdapter = adapters.find(a => a.id === subView);
  if (matchedAdapter) {
    return <AdapterSettingsSection adapter={subView} onBack={() => setSubView('main')} />;
  }

  const handleNotificationToggle = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      if (subscribed) {
        await unsubscribe();
      } else {
        await subscribe();
      }
    } finally {
      setToggling(false);
    }
  };

  const availableAdapters = adapters.filter(a => a.available);

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border">
        <button onClick={onBack} className="text-text-dim hover:text-text mr-2"><ChevronLeft className="w-5 h-5" /></button>
        <span className="text-lg font-medium text-text font-mono tracking-wide">Settings</span>
      </div>

      {/* Main list */}
      <div className="flex-1 overflow-y-auto">
        {/* Saved Instructions */}
        <button
          onClick={() => setSubView('instructions')}
          className="w-full flex items-center px-4 min-h-[48px] border-b border-border hover:bg-surface-hover transition-colors"
        >
          <span className="mr-3"><ClipboardList className="w-5 h-5 text-text-dim" /></span>
          <span className="flex-1 text-left text-text text-sm">Saved Instructions</span>
          <ChevronRight className="w-4 h-4 text-text-dim" />
        </button>

        {/* Per-adapter rows */}
        {availableAdapters.map(adapter => (
          <button
            key={adapter.id}
            onClick={() => setSubView(adapter.id)}
            className="w-full flex items-center px-4 min-h-[48px] border-b border-border hover:bg-surface-hover transition-colors"
          >
            <span className="mr-3">
              <AdapterIcon adapterId={adapter.id} size={20} />
            </span>
            <span className="flex-1 text-left text-text text-sm">{adapter.displayName}</span>
            <ChevronRight className="w-4 h-4 text-text-dim" />
          </button>
        ))}

        {/* Notifications */}
        {supported && (
          <div className="w-full flex items-center px-4 min-h-[48px] border-b border-border">
            <span className="mr-3"><Bell className="w-5 h-5 text-text-dim" /></span>
            <span className="flex-1 text-text text-sm">Notifications</span>
            <button
              onClick={handleNotificationToggle}
              disabled={toggling}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                subscribed ? 'bg-accent' : 'bg-white/20'
              } ${toggling ? 'opacity-50' : ''}`}
              aria-label="Toggle notifications"
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  subscribed ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        )}

        {/* About */}
        <div className="w-full flex items-center px-4 min-h-[48px] border-b border-border">
          <span className="mr-3"><Info className="w-5 h-5 text-text-dim" /></span>
          <span className="flex-1 text-text text-sm">About</span>
          <span className="text-text-dim text-xs font-mono">
            {version ? `ClawTap v${version}` : 'ClawTap'}
          </span>
        </div>
      </div>
    </div>
  );
}
