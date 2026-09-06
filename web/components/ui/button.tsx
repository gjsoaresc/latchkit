import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'button inline-flex items-center justify-center gap-2 rounded-md text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'button-primary bg-primary text-primary-foreground hover:bg-primary/90',
        outline:
          'button-secondary border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // A dedicated `button-destructive` class (mirroring button-primary/button-secondary)
        // gets an explicit, theme-verified hover color in style.css instead of Tailwind's
        // fractional-opacity hover utility: blending a translucent color over whatever surface
        // sits behind the button is unpredictable across themes and previously dropped hover
        // contrast below WCAG AA in dark mode (issue #90).
        destructive: 'button-destructive bg-destructive text-destructive-foreground',
      },
      size: { default: 'min-h-10 px-4 py-2', icon: 'size-10' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
