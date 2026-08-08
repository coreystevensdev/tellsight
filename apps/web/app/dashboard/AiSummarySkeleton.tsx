'use client';

import { cn } from '@/lib/utils';

const LINE_WIDTHS = ['w-full', 'w-[90%]', 'w-[95%]', 'w-[60%]'] as const;

export function AiSummarySkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8',
        className,
      )}
      role="status"
      aria-label="Loading AI summary"
    >
      <div data-testid="skeleton-title" className="mb-4 h-5 w-36 rounded bg-muted animate-skeleton-pulse motion-reduce:animate-none" />

      <div className="space-y-3">
        {LINE_WIDTHS.map((width, i) => (
          <div
            key={i}
            data-testid={`skeleton-line-${i}`}
            className={cn(
              'h-4 rounded bg-muted animate-skeleton-pulse motion-reduce:animate-none',
              width,
            )}
          />
        ))}
      </div>

      <span className="sr-only">Loading AI summary...</span>
    </div>
  );
}
