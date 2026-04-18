'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAiStream } from '@/lib/hooks/useAiStream';
import { trackClientEvent } from '@/lib/analytics';
import { UpgradeCta } from '@/components/common/UpgradeCta';
import { AiSummarySkeleton } from './AiSummarySkeleton';
import { ShareMenu, type ShareStatus, type LinkStatus } from './ShareMenu';
import { FREE_PREVIEW_WORD_LIMIT, ANALYTICS_EVENTS, AI_DISCLAIMER } from 'shared/constants';

import type { SubscriptionTier, TransparencyMetadata } from 'shared/types';

interface AiSummaryCardProps {
  datasetId: number | null;
  cachedContent?: string;
  cachedMetadata?: TransparencyMetadata | null;
  cachedStaleAt?: string | null;
  tier?: SubscriptionTier;
  onToggleTransparency?: () => void;
  transparencyOpen?: boolean;
  onMetadataReady?: (metadata: TransparencyMetadata | null) => void;
  onStreamComplete?: () => void;
  onShare?: () => Promise<void>;
  onShareDownload?: () => void;
  onShareCopy?: () => Promise<void>;
  shareState?: ShareStatus;
  onShareCopyLink?: () => Promise<void>;
  shareLinkStatus?: LinkStatus;
  shareLinkClipboardFailed?: boolean;
  onExportPdf?: () => Promise<void>;
  pdfStatus?: 'idle' | 'generating' | 'done' | 'error';
  className?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: 'The analysis took longer than expected.',
  AI_UNAVAILABLE: 'AI service is temporarily unavailable.',
  RATE_LIMITED: 'Too many requests — please wait a moment.',
  PIPELINE_ERROR: 'Something went wrong preparing your analysis.',
  EMPTY_RESPONSE: 'AI produced no results — please try again.',
  STREAM_ERROR: 'Something went wrong generating insights.',
};

function userMessage(code: string | null, fallback: string | null): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'Something went wrong generating insights.';
}

export function truncateAtWordBoundary(
  text: string,
  maxWords: number,
): { preview: string; wasTruncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { preview: text, wasTruncated: false };
  return { preview: words.slice(0, maxWords).join(' '), wasTruncated: true };
}

function RetrySpinner() {
  return (
    <svg
      className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function StreamingCursor() {
  return (
    <span
      className="animate-blink motion-reduce:animate-none"
      aria-hidden="true"
    >
      ▋
    </span>
  );
}

function highlightNumbers(text: string): React.ReactNode[] {
  const parts = text.split(/(\$[\d,]+(?:\.\d+)?[KMBkmb]?|\d+(?:\.\d+)?%)/g);
  return parts.map((part, i) =>
    /^\$[\d,]|^\d+.*%$/.test(part)
      ? <span key={i} className="font-semibold text-accent-warm" style={{ fontFeatureSettings: '"tnum"' }}>{part}</span>
      : <span key={i}>{part}</span>
  );
}

function SummaryText({ text }: { text: string }) {
  const paragraphs = text.split('\n\n').filter(Boolean);

  return (
    <div className="text-[15px] leading-[1.7] text-card-foreground/85 md:text-base md:leading-[1.75] [&>p+p]:mt-[1.1em]">
      {paragraphs.map((p, i) => (
        <p key={i} className={i === 0 ? 'text-card-foreground font-medium' : undefined}>
          {highlightNumbers(p)}
        </p>
      ))}
    </div>
  );
}

function StaleBanner({
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
        <p className="text-sm font-medium text-card-foreground">
          Your data has been updated
        </p>
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

interface PostCompletionFooterProps {
  onToggleTransparency?: () => void;
  transparencyOpen?: boolean;
  onShare?: () => Promise<void>;
  onShareDownload?: () => void;
  onShareCopy?: () => Promise<void>;
  shareState?: ShareStatus;
  onShareCopyLink?: () => Promise<void>;
  shareLinkStatus?: LinkStatus;
  shareLinkClipboardFailed?: boolean;
  onExportPdf?: () => Promise<void>;
  pdfStatus?: 'idle' | 'generating' | 'done' | 'error';
}

function PostCompletionFooter({
  onToggleTransparency,
  transparencyOpen,
  onShare,
  onShareDownload,
  onShareCopy,
  shareState = 'idle',
  onShareCopyLink,
  shareLinkStatus,
  shareLinkClipboardFailed,
  onExportPdf,
  pdfStatus,
}: PostCompletionFooterProps) {
  return (
    <div className="mt-4 border-t border-border pt-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={onToggleTransparency}
          aria-expanded={transparencyOpen}
          disabled={!onToggleTransparency}
        >
          How I reached this conclusion
          <span
            className={cn(
              'ml-1 inline-block transition-transform duration-150',
              transparencyOpen && 'rotate-180',
            )}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        <div className="ml-auto">
          {onShare && onShareDownload && onShareCopy ? (
            <ShareMenu
              status={shareState}
              onGenerate={onShare}
              onDownload={onShareDownload}
              onCopy={onShareCopy}
              onCopyLink={onShareCopyLink}
              linkStatus={shareLinkStatus}
              linkClipboardFailed={shareLinkClipboardFailed}
              onExportPdf={onExportPdf}
              pdfStatus={pdfStatus}
            />
          ) : (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              disabled
            >
              Share
            </button>
          )}
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-tight text-muted-foreground/60">{AI_DISCLAIMER}</p>
    </div>
  );
}

function FreePreviewOverlay({ previewText, onUpgrade }: { previewText: string; onUpgrade: () => void }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    trackClientEvent(ANALYTICS_EVENTS.AI_PREVIEW_VIEWED);
  }, []);

  return (
    <div className="relative">
      <SummaryText text={previewText} />

      {/* gradient fade into blurred placeholder */}
      <div className="relative mt-0" aria-hidden="true">
        <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-card/0 to-card z-10" />
        <div className="select-none blur-sm opacity-60">
          <div className="text-sm leading-[1.6] md:text-[15px] md:leading-[1.7] [&>p+p]:mt-[1em]">
            <p>Continue reading to discover key trends in your revenue growth, expense patterns, and actionable recommendations for optimizing your business performance over the coming quarter.</p>
            <p>Our analysis identifies several opportunities for cost reduction and revenue acceleration based on your historical data patterns.</p>
          </div>
        </div>
      </div>

      <div className="relative z-20 -mt-8 flex justify-center">
        <UpgradeCta
          variant="overlay"
          onUpgrade={onUpgrade}
        />
      </div>
    </div>
  );
}

export function AiSummaryCard({
  datasetId,
  cachedContent,
  cachedMetadata,
  cachedStaleAt,
  tier,
  onToggleTransparency,
  transparencyOpen,
  onMetadataReady,
  onStreamComplete,
  onShare,
  onShareDownload,
  onShareCopy,
  shareState,
  onShareCopyLink,
  shareLinkStatus,
  shareLinkClipboardFailed,
  onExportPdf,
  pdfStatus,
  className,
}: AiSummaryCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  // Snapshot staleness at mount — cachedStaleAt is a server-rendered prop, so a
  // per-render Date.now() would violate the "pure render" rule without changing
  // behavior. Re-mounts on navigation pick up a fresh value from the server.
  const [isStale] = useState(
    () => !!(cachedStaleAt && new Date(cachedStaleAt).getTime() < Date.now()),
  );
  const hasCached = !!cachedContent && !refreshing;
  const { status, text, metadata: streamMetadata, error, code, retryable, maxRetriesReached, retry } =
    useAiStream(hasCached ? null : datasetId);

  const handleRefreshInsights = () => {
    trackClientEvent(ANALYTICS_EVENTS.AI_SUMMARY_REQUESTED, { reason: 'stale_refresh' });
    setRefreshing(true);
  };

  // converge two metadata paths — stream (authenticated) or RSC cache (anonymous)
  const metadata = streamMetadata ?? cachedMetadata ?? null;

  useEffect(() => {
    onMetadataReady?.(metadata);
  }, [metadata, onMetadataReady]);

  useEffect(() => {
    if (status === 'done' || status === 'timeout') onStreamComplete?.();
  }, [status, onStreamComplete]);
  const retryPending = status === 'connecting' && text === '';

  const router = useRouter();
  const handleUpgrade = () => {
    trackClientEvent(ANALYTICS_EVENTS.SUBSCRIPTION_UPGRADE_INTENDED);
    router.push('/billing');
  };

  // cached content — AI is already "done"
  useEffect(() => {
    if (hasCached) onStreamComplete?.();
  }, [hasCached, onStreamComplete]);

  if (hasCached) {
    const isFree = tier === 'free';
    const { preview, wasTruncated } = isFree
      ? truncateAtWordBoundary(cachedContent!, FREE_PREVIEW_WORD_LIMIT)
      : { preview: cachedContent!, wasTruncated: false };

    return (
      <div
        className={cn(
          'rounded-xl border border-border/50 bg-ai-surface p-5 shadow-sm md:p-8',
          className,
        )}
        role="region"
        aria-label="AI business summary"
      >
        {isStale && (
          <StaleBanner onRefresh={handleRefreshInsights} disabled={datasetId === null} />
        )}
        <h3 className="mb-4 text-base font-semibold text-card-foreground">Analysis</h3>
        {wasTruncated ? (
          <FreePreviewOverlay previewText={preview} onUpgrade={handleUpgrade} />
        ) : (
          <>
            <SummaryText text={cachedContent!} />
            <PostCompletionFooter onToggleTransparency={onToggleTransparency} transparencyOpen={transparencyOpen} onShare={onShare} onShareDownload={onShareDownload} onShareCopy={onShareCopy} shareState={shareState} onShareCopyLink={onShareCopyLink} shareLinkStatus={shareLinkStatus} shareLinkClipboardFailed={shareLinkClipboardFailed} onExportPdf={onExportPdf} pdfStatus={pdfStatus} />
          </>
        )}
      </div>
    );
  }

  if (status === 'idle') return null;

  // free preview from SSE — backend truncated + sent upgrade_required
  if (status === 'free_preview') {
    return (
      <div
        className={cn(
          'rounded-xl border border-border/50 bg-ai-surface p-5 shadow-sm md:p-8',
          className,
        )}
        role="region"
        aria-label="AI business summary"
      >
        <FreePreviewOverlay previewText={text} onUpgrade={handleUpgrade} />
      </div>
    );
  }

  if (status === 'connecting') {
    return (
      <div className={cn('relative', className)}>
        <AiSummarySkeleton />
        <p className="mt-2 text-sm text-muted-foreground animate-fade-in">
          Analyzing your data...
        </p>
      </div>
    );
  }

  if (status === 'timeout') {
    return (
      <div
        className={cn(
          'rounded-xl border border-border/50 bg-ai-surface p-5 shadow-sm md:p-8',
          className,
        )}
        role="region"
        aria-label="AI business summary"
      >
        <div aria-live="polite">
          <SummaryText text={text} />
        </div>
        <hr className="my-4 border-muted" />
        <p className="text-sm italic text-muted-foreground">
          We focused on the most important findings to keep things quick.
        </p>
        <PostCompletionFooter onToggleTransparency={onToggleTransparency} transparencyOpen={transparencyOpen} onShare={onShare} onShareDownload={onShareDownload} onShareCopy={onShareCopy} shareState={shareState} onShareCopyLink={onShareCopyLink} shareLinkStatus={shareLinkStatus} shareLinkClipboardFailed={shareLinkClipboardFailed} onExportPdf={onExportPdf} pdfStatus={pdfStatus} />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        className={cn(
          'rounded-xl border border-destructive/30 bg-destructive/[0.03] p-5 shadow-sm md:p-8',
          className,
        )}
        role="region"
        aria-label="AI business summary"
      >
        <div aria-live="assertive">
          <p className="text-sm font-medium text-destructive">
            {userMessage(code, error)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your data and charts are still available below.
          </p>
        </div>
        {retryable && !maxRetriesReached && (
          <button
            type="button"
            disabled={retryPending}
            onClick={retry}
            className="mt-3 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {retryPending && <RetrySpinner />}
            {retryPending ? 'Retrying...' : 'Try again'}
          </button>
        )}
        {retryable && maxRetriesReached && (
          <p className="mt-3 text-xs text-muted-foreground">
            Please try again later.
          </p>
        )}
      </div>
    );
  }

  const isActive = status === 'streaming';
  const isDone = status === 'done';

  return (
    <div
      className={cn(
        'rounded-xl border border-border/50 bg-ai-surface p-5 shadow-sm md:p-8',
        isDone && 'animate-settle motion-reduce:animate-none',
        className,
      )}
      role="region"
      aria-label="AI business summary"
    >
      <h3 className="mb-4 text-base font-semibold text-card-foreground">Analysis</h3>
      <div
        aria-live="polite"
        aria-busy={isActive}
      >
        <SummaryText text={text} />
        {isActive && <StreamingCursor />}
      </div>
      {isDone && <PostCompletionFooter onToggleTransparency={onToggleTransparency} transparencyOpen={transparencyOpen} onShare={onShare} onShareDownload={onShareDownload} onShareCopy={onShareCopy} shareState={shareState} onShareCopyLink={onShareCopyLink} shareLinkStatus={shareLinkStatus} shareLinkClipboardFailed={shareLinkClipboardFailed} onExportPdf={onExportPdf} pdfStatus={pdfStatus} />}
    </div>
  );
}
