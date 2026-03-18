import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface BottomSheetProps {
  visible: boolean;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
  /** Extra classes for the backdrop overlay */
  backdropClassName?: string;
  /** z-index class (default: z-50) */
  zIndex?: 'z-30' | 'z-40' | 'z-50' | 'z-60';
  /** Show drag handle bar at top (default: true when onClose provided) */
  showHandle?: boolean;
}

/**
 * Shared bottom sheet — backdrop + slide-up panel.
 * Replaces the repeated pattern across SendToExistingSheet, PermissionOverlay,
 * StatusBar pickers, ReviewActionMenu, etc.
 */
export function BottomSheet({ visible, onClose, children, className, backdropClassName, zIndex = 'z-50', showHandle }: BottomSheetProps) {
  if (!visible) return null;

  const shouldShowHandle = showHandle ?? !!onClose;

  return (
    <div className={cn('fixed inset-0 flex items-end justify-center', zIndex)} onClick={onClose}>
      <div className={cn('absolute inset-0 bg-black/50', backdropClassName)} />
      <div
        className={cn(
          'relative w-full bg-surface border-t border-border rounded-t-xl safe-bottom animate-[slideUp_0.25s_ease-out]',
          className,
        )}
        onClick={e => e.stopPropagation()}
      >
        {shouldShowHandle && (
          <div className="w-8 h-0.5 rounded-sm bg-border mx-auto mt-2 mb-1 cursor-pointer" onClick={onClose} />
        )}
        {children}
      </div>
    </div>
  );
}
