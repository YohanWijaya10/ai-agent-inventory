import * as React from 'react';
import { cn } from '@/lib/cn';

type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'warning' | 'destructive' | 'info';
};

export function Alert({ className, variant = 'default', ...props }: AlertProps) {
  const variants: Record<string, string> = {
    default: 'bg-gray-50 text-gray-800 border-gray-200',
    warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
    destructive: 'bg-red-50 text-red-800 border-red-200',
    info: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  };
  return <div className={cn('border rounded-md p-3', variants[variant], className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('font-semibold', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm mt-1', className)} {...props} />;
}

