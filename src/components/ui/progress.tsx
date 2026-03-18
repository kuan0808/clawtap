import * as React from 'react';
import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, variant = 'default', ...props }, ref) => {
    const colors = {
      default: 'bg-accent',
      success: 'bg-success',
      warning: 'bg-warning',
      danger: 'bg-danger',
    };
    return (
      <div ref={ref} className={cn('h-1 w-full overflow-hidden rounded-sm bg-surface-light', className)} {...props}>
        <div
          className={cn('h-full rounded-sm transition-all duration-300', colors[variant])}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    );
  }
);
Progress.displayName = 'Progress';

export { Progress };
