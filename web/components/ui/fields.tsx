import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';

const fieldClass =
  'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs disabled:opacity-50';
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(fieldClass, className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, 'min-h-24 resize-y', className)}
      {...props}
    />
  );
}
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn(fieldClass, className)} {...props} />;
}
export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('grid gap-2 text-xs font-medium', className)}
      {...props}
    />
  );
}
