import { getBrand } from '@/lib/adapter-brands';

export function CollapsedReviewCard({
  adapter,
  title,
  summary,
  onClick,
}: {
  adapter: string;
  title?: string;
  summary: string;
  onClick: () => void;
}) {
  const brand = getBrand(adapter);
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-md p-3 transition-colors hover:opacity-80"
      style={{ backgroundColor: `${brand.color}08`, border: `1px solid ${brand.color}20` }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium" style={{ color: brand.color }}>
          {brand.displayName} {title || 'Review'}
        </span>
        <span className="text-[10px] text-text-dim ml-auto">tap to expand</span>
      </div>
      {summary && (
        <div className="text-[11px] text-text-dim mt-1 line-clamp-2">{summary}</div>
      )}
    </button>
  );
}
