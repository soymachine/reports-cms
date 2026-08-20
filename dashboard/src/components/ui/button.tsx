import React from 'react';

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm hover:shadow-md dark:bg-emerald-600 dark:hover:bg-emerald-500',
  ghost:
    'bg-transparent text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800',
  outline:
    'bg-transparent border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400',
  danger:
    'bg-transparent border border-rose-300 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10',
};

export function Button({
  children,
  variant = 'primary',
  className = '',
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${className}`}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
