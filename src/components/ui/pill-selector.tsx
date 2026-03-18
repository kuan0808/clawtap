import { cn } from '@/lib/utils';

interface PillOption {
  readonly value: string;
  readonly label: string;
}

export function PillSelector<T extends PillOption>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-1 bg-surface rounded-md p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-2 py-1 rounded text-xs font-medium font-mono tracking-wide transition-colors cursor-pointer',
            value === opt.value
              ? 'bg-accent/20 text-accent'
              : 'text-text-dim hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
