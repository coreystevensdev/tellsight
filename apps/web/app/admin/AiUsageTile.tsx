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

// Prompt-version bumps invalidate ai_summaries cache and trigger fresh
// generations. Without this tile, the resulting cost spike is invisible
// until the monthly Anthropic bill lands.
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
