'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAiStream, stripDisplayTags } from '@/lib/hooks/useAiStream';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { trackClientEvent } from '@/lib/analytics';
import type { ShareStatus, LinkStatus } from './ShareMenu';
import { parseStatBindings, type StatBinding } from './parseStatBindings';
import { parseCiteBindings, type CiteBinding } from './parseCiteBindings';
import { InsightChartSheet } from './InsightChartSheet';
import { StatDetailSheet } from './StatDetailSheet';
import { type CashBalancePoint } from './charts/RunwayTrendChart';
import { SummaryText } from './SummaryText';
import { FreePreviewOverlay, PostCompletionFooter } from './AiSummaryCompletion';
import {
  AiSummaryConnecting,
  AiSummaryError,
  StaleSummaryBanner,
  StreamingCursor,
} from './AiSummaryStates';
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

export function truncateAtWordBoundary(
  text: string,
  maxWords: number,
): { preview: string; wasTruncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { preview: text, wasTruncated: false };
  return { preview: words.slice(0, maxWords).join(' '), wasTruncated: true };
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
          <StaleSummaryBanner onRefresh={handleRefreshInsights} disabled={datasetId === null} />
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
    return <AiSummaryConnecting className={className} />;
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
      <AiSummaryError
        code={code}
        error={error}
        retryable={retryable}
        maxRetriesReached={maxRetriesReached}
        retryPending={retryPending}
        onRetry={retry}
        className={className}
      />
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
