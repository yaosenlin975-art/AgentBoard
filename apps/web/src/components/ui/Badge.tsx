import type { ReactNode } from 'react';

const TONES = {
  neutral: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  gray: 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
