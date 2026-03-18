import { ADAPTER_BRANDS, type AdapterBrand } from '@/lib/adapter-brands';

const TABS: { id: string; label: string; brand: AdapterBrand | null }[] = [
  { id: 'all', label: 'All', brand: null },
  ...Object.values(ADAPTER_BRANDS).map(b => ({ id: b.id, label: b.displayName, brand: b })),
];

export function AdapterTabs({
  active,
  onChange,
}: {
  active: string;
  onChange: (tab: string) => void;
}) {
  return (
    <div className="flex border-b border-border">
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors ${
              isActive
                ? 'font-semibold text-accent border-b-2 border-accent'
                : 'font-medium text-text-dim hover:text-text'
            }`}
          >
            {tab.brand && (
              <span
                className="inline-block w-2 h-2 rounded-sm shrink-0"
                style={{ backgroundColor: tab.brand.color }}
              />
            )}
            <span className="font-mono tracking-wide">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
