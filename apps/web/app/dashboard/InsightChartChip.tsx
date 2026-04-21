'use client';

import { ArrowRight, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getStatChartConfig } from './charts/statChartMap';

export interface InsightChartChipProps {
  statId: string;
  onOpen: () => void;
  className?: string;
}

// Mobile-friendly affordance — replaces the desktop thumbnail at <768px.
// Tap target meets WCAG 44×44 (44px tall via py-2 + text + padding).
// Same drill-down sheet trigger as the thumbnail; only the visual differs.
export function InsightChartChip({ statId, onOpen, className }: InsightChartChipProps) {
  const config = getStatChartConfig(statId);
  if (!config) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${config.label} drill-down`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-xs font-medium text-card-foreground transition-colors duration-200 ease-out hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/40',
        className,
      )}
    >
      <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{config.label}</span>
      <ArrowRight className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}
