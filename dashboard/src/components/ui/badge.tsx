import React from 'react';

type BadgeVariant = 'default' | 'a' | 'b' | 'c' | 'd' | 'accent' | 'outline';

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700',
  a: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
  b: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  c: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
  d: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 border-zinc-500/30',
  accent: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  outline: 'bg-transparent text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700',
};

export function priorityVariant(priority?: string | null): BadgeVariant {
  if (!priority) return 'default';
  const letter = priority.trim().charAt(0).toUpperCase();
  if (letter === 'A') return 'a';
  if (letter === 'B') return 'b';
  if (letter === 'C') return 'c';
  if (letter === 'D') return 'd';
  return 'default';
}

export function Badge({
  children,
  variant = 'default',
  className = '',
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-all duration-200 hover:scale-[1.03] cursor-default ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
