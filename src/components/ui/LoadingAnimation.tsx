import { cn } from '@/lib/utils';

/**
 * LoadingAnimation — SVG pixel claw (8×6) that walks right and eats dots.
 * Pincers pivot from the root joint with 12° open/close.
 */

const sizeConfig = {
  sm: { svgW: 24, svgH: 18, dotSize: 3, dotGap: 5, dots: 3, height: 'h-8' },
  md: { svgW: 48, svgH: 36, dotSize: 4, dotGap: 8, dots: 5, height: 'h-12' },
  lg: { svgW: 64, svgH: 48, dotSize: 5, dotGap: 10, dots: 6, height: 'h-16' },
} as const;

interface Props {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

function PixelClaw({ width, height }: { width: number; height: number }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 8 6"
      style={{ imageRendering: 'pixelated' }}
      className="claw-svg"
    >
      {/* Top pincer — pivots from root (3,2) */}
      <g className="claw-pincer-top">
        <rect x="4" y="0" width="4" height="1" fill="#22c55e" />
        <rect x="3" y="1" width="2" height="1" fill="#22c55e" />
      </g>
      {/* Body */}
      <rect x="0" y="2" width="4" height="2" fill="#22c55e" />
      <rect x="4" y="2" width="1" height="2" fill="#4ade80" opacity="0.5" />
      {/* Bottom pincer — pivots from root (3,4) */}
      <g className="claw-pincer-bot">
        <rect x="3" y="4" width="2" height="1" fill="#22c55e" />
        <rect x="4" y="5" width="4" height="1" fill="#22c55e" />
      </g>
    </svg>
  );
}

export function LoadingAnimation({ size = 'md', label, className }: Props) {
  const cfg = sizeConfig[size];

  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <div className={cn('relative flex items-center justify-center overflow-hidden', cfg.height)}>
        <div className="flex items-center">
          {/* Claw walks right */}
          <div className="claw-walk">
            <PixelClaw width={cfg.svgW} height={cfg.svgH} />
          </div>

          {/* Dots that get eaten */}
          <div className="flex items-center" style={{ gap: cfg.dotGap, marginLeft: 4 }}>
            {Array.from({ length: cfg.dots }).map((_, i) => (
              <div
                key={i}
                className="claw-dot rounded-full"
                style={{
                  width: cfg.dotSize,
                  height: cfg.dotSize,
                  background: 'rgba(34, 197, 94, 0.35)',
                  animationDelay: `${i * 0.35}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {label && (
        <span className="text-xs text-text-dim font-mono animate-pulse">{label}</span>
      )}
    </div>
  );
}
