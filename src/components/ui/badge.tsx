import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
  {
    variants: {
      variant: {
        default: 'bg-accent/15 text-accent-light',
        secondary: 'bg-surface-light text-text-dim',
        success: 'bg-success/15 text-success',
        destructive: 'bg-danger/15 text-danger',
        warning: 'bg-warning/15 text-warning',
        outline: 'border border-border text-text-dim',
        mono: 'bg-surface-light text-text-secondary font-mono',
        terminal: 'border border-accent/30 text-accent bg-accent/5 font-mono tracking-wider uppercase',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
