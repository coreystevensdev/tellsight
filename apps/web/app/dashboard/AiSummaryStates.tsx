import { RefreshCw } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { AiSummarySkeleton } from './AiSummarySkeleton';

const ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: 'The analysis timed out before it finished. Try again.',
  AI_UNAVAILABLE: 'The AI service is not responding. Nothing else on the page is affected.',
  RATE_LIMITED: "You've hit the request limit. Wait a minute, then try again.",
  PIPELINE_ERROR: 'Your data could not be prepared for analysis. The charts still work.',
  EMPTY_RESPONSE: 'The analysis came back empty. Try again.',
  STREAM_ERROR: 'The analysis stopped partway through. Try again.',
  AUTHENTICATION_REQUIRED: 'Your session expired. Sign in again to refresh this analysis.',
};

function userMessage(code: string | null, fallback: string | null): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'The analysis could not be generated. Try again.';
}

export function StreamingCursor() {
  return (
    <span className="animate-blink motion-reduce:animate-none" aria-hidden="true">
      ▋
    </span>
  );
}

export function StaleSummaryBanner({
  onRefresh,
  disabled,
}: {
  onRefresh: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-start gap-3 rounded-lg border border-accent-warm/40 bg-accent-warm/10 px-4 py-3"
    >
      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent-warm" aria-hidden="true" />
      <div className="flex-1">
        <p className="text-sm font-medium text-card-foreground">Your data has been updated</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          These insights were written before your latest sync. Refresh to regenerate them.
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        className="shrink-0 rounded-md bg-accent-warm px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-warm/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Refresh insights
      </button>
    </div>
  );
}

export function AiSummaryConnecting({ className }: { className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <AiSummarySkeleton />
      <p className="mt-2 text-sm text-muted-foreground animate-fade-in">Analyzing your data...</p>
    </div>
  );
}

interface AiSummaryErrorProps {
  code: string | null;
  error: string | null;
  retryable: boolean;
  maxRetriesReached: boolean;
  retryPending: boolean;
  onRetry: () => void;
  className?: string;
}

export function AiSummaryError({
  code,
  error,
  retryable,
  maxRetriesReached,
  retryPending,
  onRetry,
  className,
}: AiSummaryErrorProps) {
  return (
    <div
      className={cn(
        'min-w-0 border-t-2 border-destructive bg-destructive/[0.03] p-5 md:p-8',
        className,
      )}
      role="region"
      aria-label="AI business summary"
    >
      <div aria-live="assertive">
        <p className="text-sm font-medium text-destructive">{userMessage(code, error)}</p>
        <p className="mt-1 text-sm text-muted-foreground">Your data and charts are unaffected.</p>
      </div>
      {retryable && !maxRetriesReached && (
        <button
          type="button"
          disabled={retryPending}
          onClick={onRetry}
          className="mt-3 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {retryPending && <Spinner className="mr-2" />}
          {retryPending ? 'Retrying...' : 'Try again'}
        </button>
      )}
      {retryable && maxRetriesReached && (
        <p className="mt-3 text-xs text-muted-foreground">
          Out of retries. Try again in a few minutes.
        </p>
      )}
    </div>
  );
}
