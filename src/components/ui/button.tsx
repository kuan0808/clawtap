import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-bg hover:bg-accent-light',
        destructive: 'bg-danger text-white hover:bg-danger/80',
        outline: 'border border-border bg-transparent text-text hover:bg-surface-light',
        secondary: 'bg-surface-light text-text hover:bg-border',
        ghost: 'text-text-dim hover:text-text hover:bg-surface-light',
        link: 'text-accent underline-offset-4 hover:underline',
        terminal: 'bg-transparent border border-accent text-accent hover:bg-accent/10 font-mono',
      },
      size: {
        default: 'h-9 px-3 py-2',
        sm: 'h-8 px-2.5 text-xs',
        lg: 'h-10 px-4',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
