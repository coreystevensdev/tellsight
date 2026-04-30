import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles } from 'lucide-react';
import type { AiUsageStats } from './types';

interface AiUsageTileProps {
  usage: AiUsageStats;
}

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const tokenFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Month-to-date Anthropic token spend, estimated. Not an invoice, actual
 * billing depends on model variant per request and prompt-caching discounts.
 * Rate card source: shared/constants.CLAUDE_PRICING (Sonnet 4.5 default).
 *
 * Purpose: catch cost spikes from prompt-version bumps before the monthly
 * Anthropic bill lands. Each Epic 8 prompt version bump (4 in the epic)
 * invalidated `ai_summaries` cache, triggering fresh generations on next
 * read. Without this tile, that cost spike is invisible until accounting.
 */
export function AiUsageTile({ usage }: AiUsageTileProps) {
  const inputLabel = tokenFormatter.format(usage.inputTokens);
  const outputLabel = tokenFormatter.format(usage.outputTokens);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">AI Cost (MTD)</CardTitle>
        <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <div
          className="text-2xl font-bold"
          style={{ fontFeatureSettings: '"tnum"' }}
          aria-label={`Estimated cost ${costFormatter.format(usage.estimatedCostUsd)} month to date`}
        >
          {costFormatter.format(usage.estimatedCostUsd)}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {usage.requestCount} {usage.requestCount === 1 ? 'request' : 'requests'} · {inputLabel} in · {outputLabel} out
        </p>
      </CardContent>
    </Card>
  );
}
