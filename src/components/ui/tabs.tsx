"use client";
import * as React from 'react';
import { cn } from '@/lib/cn';

type TabsCtx = { value: string; setValue: (v: string) => void };
const Ctx = React.createContext<TabsCtx | null>(null);

export function Tabs({ value, onValueChange, children, className }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode; className?: string }) {
  const ctx = React.useMemo(() => ({ value, setValue: onValueChange }), [value, onValueChange]);
  return <div className={cn('w-full', className)}><Ctx.Provider value={ctx}>{children}</Ctx.Provider></div>;
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('inline-flex items-center gap-1 rounded-md border bg-white p-1', className)} {...props} />;
}

export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  const ctx = React.useContext(Ctx)!;
  const active = ctx.value === value;
  return (
    <button onClick={() => ctx.setValue(value)} className={cn('px-3 py-1.5 text-sm rounded-md', active ? 'bg-brand-600 text-white' : 'hover:bg-gray-50')}>{children}</button>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const ctx = React.useContext(Ctx)!;
  if (ctx.value !== value) return null;
  return <div className={cn('mt-3', className)}>{children}</div>;
}

