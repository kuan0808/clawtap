export function BlockMarker({ label, color = '#86efac' }: { label: string; color?: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="flex-1 h-px" style={{ backgroundColor: `${color}30` }} />
      <span
        className="text-[10px] px-2.5 py-0.5 rounded whitespace-nowrap"
        style={{ color, backgroundColor: `${color}15` }}
      >
        {label}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: `${color}30` }} />
    </div>
  );
}
