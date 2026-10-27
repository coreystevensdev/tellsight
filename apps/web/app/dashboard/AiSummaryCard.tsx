'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAiStream, stripDisplayTags } from '@/lib/hooks/useAiStream';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { trackClientEvent } from '@/lib/analytics';
import { Spinner } from '@/components/ui/spinner';
import { AiSummarySkeleton } from './AiSummarySkeleton';
import type { ShareStatus, LinkStatus } from './ShareMenu';
import { parseStatBindings, type StatBinding } from './parseStatBindings';
import { parseCiteBindings, type CiteBinding } from './parseCiteBindings';
import { InsightChartSheet } from './InsightChartSheet';
import { StatDetailSheet } from './StatDetailSheet';
import { type CashBalancePoint } from './charts/RunwayTrendChart';
import { SummaryText } from './SummaryText';
import { FreePreviewOverlay, PostCompletionFooter } from './AiSummaryCompletion';
import { FREE_PREVIEW_WORD_LIMIT, ANALYTICS_EVENTS } from 'shared/constants';

import type { SubscriptionTier, TransparencyMetadata } from 'shared/types';

interface AiSummaryCardProps {
  datasetId: number | null;
  cachedContent?: string;
  cachedMetadata?: TransparencyMetadata | null;
  cachedStaleAt?: string | null;
  // Defaults to false so a caller that forgets it hides the refresh control
  // rather than offering one that 401s.
  hasAuth?: boolean;
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
  cashHistory?: CashBalancePoint[];
  cashForecast?: CashBalancePoint[];
  className?: string;
}

// Each of these names the thing that failed and what to do next. Four were
// "Something went wrong" with the noun swapped, which tells a reader nothing.
const ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: 'The analysis timed out before it finished. Try again.',
  AI_UNAVAILABLE: 'The AI service is not responding. Nothing else on the page is affected.',
  RATE_LIMITED: "You've hit the request limit. Wait a minute, then try again.",
  PIPELINE_ERROR: 'Your data could not be prepared for analysis. The charts still work.',
  EMPTY_RESPONSE: 'The analysis came back empty. Try again.',
  STREAM_ERROR: 'The analysis stopped partway through. Try again.',
  // Reachable when a session expires mid-read. Without an entry here
  // userMessage falls through to the API's wording, and 'Missing access
  // token' is what the reader gets where the analysis used to be.
  AUTHENTICATION_REQUIRED: 'Your session expired. Sign in again to refresh this analysis.',
};

function userMessage(code: string | null, fallback: string | null): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'The analysis could not be generated. Try again.';
}

export function truncateAtWordBoundary(
  text: string,
  maxWords: number,
): { preview: string; wasTruncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { preview: text, wasTruncated: false };
  return { preview: words.slice(0, maxWords).join(' '), wasTruncated: true };
}

function StreamingCursor() {
  return (
    <span className="animate-blink motion-reduce:animate-none" aria-hidden="true">
      ▋
    </span>
  );
}

function StaleBanner({ onRefresh, disabled }: { onRefresh: () => void; disabled?: boolean }) {
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

export function AiSummaryCard({
  datasetId,
  cachedContent,
  cachedMetadata,
  cachedStaleAt,
  hasAuth = false,
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
  cashHistory,
  cashForecast,
  className,
}: AiSummaryCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  // Staleness is a comparison against the clock, and the clock reads differently
  // on the server than it does a moment later in the browser. getServerSnapshot
  // pins the server to false, so the markup React renders and the markup it
  // hydrates against agree by construction rather than by argument, and the real
  // answer arrives immediately after hydration.
  //
  // A useState lazy initializer cannot do this: it runs once in the server pass
  // and again in the hydration render, and Date.now() has moved between them.
  //
  // subscribe is a no-op because nothing here emits. Time passing is not an
  // event, so this re-reads on render rather than pushing. That is strictly more
  // current than the mount-only effect it replaces, which could not notice
  // cachedStaleAt changing under it at all.
  const isStale = useSyncExternalStore(
    () => () => {},
    () => (cachedStaleAt ? new Date(cachedStaleAt).getTime() < Date.now() : false),
    () => false,
  );
  const hasCached = !!cachedContent && !refreshing;
  const {
    status,
    text,
    rawText,
    metadata: streamMetadata,
    error,
    code,
    retryable,
    maxRetriesReached,
    retry,
  } = useAiStream(hasCached ? null : datasetId);

  const isMobile = useIsMobile();
  const [openStatId, setOpenStatId] = useState<string | null>(null);
  const [openParagraphText, setOpenParagraphText] = useState<string>('');
  const [openCiteId, setOpenCiteId] = useState<string | null>(null);

  // bindings come from the raw buffer (tags intact). Streaming path uses
  // useAiStream.rawText; cached path parses cachedContent directly. Both
  // strip tags for display via stripStatTags so the user never sees a
  // raw <stat id="..."/> token regardless of code path.
  const sourceText = hasCached ? (cachedContent ?? '') : rawText;
  const bindings = useMemo<StatBinding[]>(() => {
    if (status !== 'done' && !hasCached) return [];
    return parseStatBindings(sourceText);
  }, [sourceText, status, hasCached]);

  // same buffer as bindings, a different mechanism: many per-number <cite>
  // markers instead of one per-paragraph <stat> chip.
  const citations = useMemo<CiteBinding[]>(() => {
    if (status !== 'done' && !hasCached) return [];
    return parseCiteBindings(sourceText);
  }, [sourceText, status, hasCached]);

  const displayText = hasCached ? stripDisplayTags(cachedContent ?? '') : text;

  const handleOpenStat = (statId: string, paragraphIndex: number) => {
    const paragraphs = stripDisplayTags(sourceText).split('\n\n').filter(Boolean);
    setOpenStatId(statId);
    setOpenParagraphText(paragraphs[paragraphIndex] ?? '');
    trackClientEvent(ANALYTICS_EVENTS.INSIGHT_CHART_OPENED, {
      statType: statId,
      paragraphIndex,
      viewport: isMobile ? 'mobile' : 'desktop',
    });
  };

  const handleOpenCite = (statId: string) => {
    setOpenCiteId(statId);
  };

  const handleRefreshInsights = () => {
    trackClientEvent(ANALYTICS_EVENTS.AI_SUMMARY_REQUESTED, { reason: 'stale_refresh' });
    setRefreshing(true);
  };

  // converge two metadata paths, stream (authenticated) or RSC cache (anonymous)
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

  // cached content, AI is already "done"
  useEffect(() => {
    if (hasCached) onStreamComplete?.();
  }, [hasCached, onStreamComplete]);

  const completionFooter = (
    <PostCompletionFooter
      onToggleTransparency={onToggleTransparency}
      transparencyOpen={transparencyOpen}
      onShare={onShare}
      onShareDownload={onShareDownload}
      onShareCopy={onShareCopy}
      shareState={shareState}
      onShareCopyLink={onShareCopyLink}
      shareLinkStatus={shareLinkStatus}
      shareLinkClipboardFailed={shareLinkClipboardFailed}
      onExportPdf={onExportPdf}
      pdfStatus={pdfStatus}
    />
  );

  const detailSheets = (
    <>
      <InsightChartSheet
        open={openStatId !== null}
        onOpenChange={(open) => !open && setOpenStatId(null)}
        statId={openStatId}
        paragraphText={openParagraphText}
        cashHistory={cashHistory}
        cashForecast={cashForecast}
      />
      <StatDetailSheet
        open={openCiteId !== null}
        onOpenChange={(open) => !open && setOpenCiteId(null)}
        datasetId={datasetId}
        statId={openCiteId}
      />
    </>
  );

  if (hasCached) {
    const isFree = tier === 'free';
    const { preview, wasTruncated } = isFree
      ? truncateAtWordBoundary(cachedContent!, FREE_PREVIEW_WORD_LIMIT)
      : { preview: cachedContent!, wasTruncated: false };

    return (
      <div
        className={cn('min-w-0 border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8', className)}
        role="region"
        aria-label="AI business summary"
      >
        {/* hasAuth, not just isStale: refreshing streams over the protected
            route, so offering it to a signed-out visitor 401s and replaces the
            summary it was meant to update. The anonymous path reads the RSC
            cache and has nothing to refresh anyway. */}
        {isStale && hasAuth && (
          <StaleBanner onRefresh={handleRefreshInsights} disabled={datasetId === null} />
        )}
        <h3 className="mb-4 font-serif text-lg font-medium text-card-foreground">Analysis</h3>
        {wasTruncated ? (
          <FreePreviewOverlay previewText={stripDisplayTags(preview)} onUpgrade={handleUpgrade} />
        ) : (
          <>
            <SummaryText
              text={displayText}
              bindings={bindings}
              citations={citations}
              onOpenStat={handleOpenStat}
              onOpenCite={handleOpenCite}
              cashHistory={cashHistory}
              cashForecast={cashForecast}
              isMobile={isMobile}
            />
            {completionFooter}
          </>
        )}
        {detailSheets}
      </div>
    );
  }

  if (status === 'idle') return null;

  // free preview from SSE, backend truncated + sent upgrade_required
  if (status === 'free_preview') {
    return (
      <div
        className={cn('min-w-0 border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8', className)}
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
        <p className="mt-2 text-sm text-muted-foreground animate-fade-in">Analyzing your data...</p>
      </div>
    );
  }

  if (status === 'timeout') {
    return (
      <div
        className={cn('min-w-0 border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8', className)}
        role="region"
        aria-label="AI business summary"
      >
        <div aria-live="polite">
          <SummaryText
            text={text}
            bindings={bindings}
            citations={citations}
            onOpenStat={handleOpenStat}
            onOpenCite={handleOpenCite}
            cashHistory={cashHistory}
            cashForecast={cashForecast}
            isMobile={isMobile}
          />
        </div>
        <hr className="my-4 border-muted" />
        <p className="text-sm italic text-muted-foreground">
          We focused on the most important findings to keep things quick.
        </p>
        {completionFooter}
        {detailSheets}
      </div>
    );
  }

  if (status === 'error') {
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
            onClick={retry}
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

  const isActive = status === 'streaming';
  const isDone = status === 'done';

  return (
    <div
      className={cn(
        'min-w-0 border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8',
        isDone && 'animate-settle motion-reduce:animate-none',
        className,
      )}
      role="region"
      aria-label="AI business summary"
    >
      <h3 className="mb-4 font-serif text-lg font-medium text-card-foreground">Analysis</h3>
      <div aria-live="polite" aria-busy={isActive}>
        <SummaryText
          text={text}
          bindings={isDone ? bindings : undefined}
          citations={isDone ? citations : undefined}
          onOpenStat={isDone ? handleOpenStat : undefined}
          onOpenCite={isDone ? handleOpenCite : undefined}
          cashHistory={cashHistory}
          cashForecast={cashForecast}
          isMobile={isMobile}
        />
        {isActive && <StreamingCursor />}
      </div>
      {isDone && completionFooter}
      {detailSheets}
    </div>
  );
}
