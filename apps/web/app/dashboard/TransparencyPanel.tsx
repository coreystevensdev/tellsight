'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

import type { TransparencyMetadata } from 'shared/types';

interface TransparencyPanelProps {
  metadata: TransparencyMetadata | null;
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (seconds < 60) return rtf.format(-seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  return rtf.format(-days, 'day');
}

const STAT_TYPE_LABELS: Record<string, string> = {
  total: 'Total analysis',
  average: 'Average computation',
  trend: 'Trend analysis',
  anomaly: 'Anomaly detection',
  category_breakdown: 'Category breakdown',
  year_over_year: 'Year-over-year comparison',
  margin_trend: 'Margin trend',
  seasonal_projection: 'Seasonal projection',
  cash_flow: 'Cash Flow',
};

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

export function TransparencyPanel({ metadata, isOpen, onClose, className }: TransparencyPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // focus close button on open
  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  // escape key closes
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen || !metadata) return null;

  return (
    <aside
      role="complementary"
      aria-label="AI analysis methodology"
      aria-live="polite"
      className={cn('border-l border-border bg-card p-4 shadow-sm', className)}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          How I reached this conclusion
        </h3>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close transparency panel"
          className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* statistics computed */}
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Statistics computed
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {metadata.statTypes.map((st) => (
            <Badge key={st}>{STAT_TYPE_LABELS[st] ?? st}</Badge>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {metadata.insightCount} key insights from {metadata.categoryCount} categories
        </p>
      </div>

      {/* scoring weights */}
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Insight scoring
        </p>
        <div className="mt-2 space-y-1.5">
          {(['novelty', 'actionability', 'specificity'] as const).map((key) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="capitalize text-foreground">{key}</span>
              <span className="text-muted-foreground">
                {Math.round(metadata.scoringWeights[key] * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* version + timestamp */}
      <div className="mt-4 flex items-center gap-2">
        <Badge>{metadata.promptVersion}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(metadata.generatedAt)}
        </span>
      </div>
    </aside>
  );
}
