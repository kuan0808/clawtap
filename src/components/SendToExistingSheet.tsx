import { getBrand } from '../lib/adapter-brands';
import type { ReviewInfo } from '../hooks/useChat';
import { BottomSheet } from './BottomSheet';

interface SendToExistingSheetProps {
  visible: boolean;
  activeReviews: ReviewInfo[];
  onSendToExisting: (reviewId: string) => void;
  onStartNew: () => void;
  onClose: () => void;
}

export function SendToExistingSheet({ visible, activeReviews, onSendToExisting, onStartNew, onClose }: SendToExistingSheetProps) {
  return (
    <BottomSheet visible={visible} onClose={onClose} className="max-w-lg p-4 space-y-2">
      <p className="text-xs text-text-dim font-mono mb-2">Send to active review</p>

      {activeReviews.map(r => {
        const brand = getBrand(r.childAdapter);
        return (
          <button
            key={r.reviewId}
            onClick={() => onSendToExisting(r.reviewId)}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border hover:bg-white/5 transition-colors text-left"
          >
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded"
              style={{ backgroundColor: `${brand.color}20`, color: brand.color }}
            >
              {brand.displayName}
            </span>
            <span className="text-sm text-text font-mono flex-1 truncate">
              {r.reviewTitle || 'Review'}
            </span>
            <span className="text-xs text-text-dim">{'\u2192'}</span>
          </button>
        );
      })}

      <div className="border-t border-border pt-2 mt-2">
        <button
          onClick={onStartNew}
          className="w-full text-left px-3 py-2 text-xs text-text-dim hover:text-text hover:bg-white/5 rounded-lg transition-colors font-mono"
        >
          Start new review...
        </button>
      </div>
    </BottomSheet>
  );
}
