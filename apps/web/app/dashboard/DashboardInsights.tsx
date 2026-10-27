'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import { ANALYTICS_EVENTS } from 'shared/constants';
import type { SubscriptionTier, TransparencyMetadata } from 'shared/types';
import type { BusinessProfile } from 'shared/schemas';

import { IndustryBenchmark } from '@/components/IndustryBenchmark';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { trackClientEvent } from '@/lib/analytics';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import type { useDashboardSharing } from '@/lib/hooks/useDashboardSharing';
import { cn } from '@/lib/utils';
import { AiSummaryCard } from './AiSummaryCard';
import { AiSummaryErrorBoundary } from './AiSummaryErrorBoundary';
import { LastDigestIndicator } from '@/components/LastDigestIndicator';
import { QaAskBox } from './QaAskBox';
import { TransparencyPanel } from './TransparencyPanel';

interface DashboardInsightsProps {
  datasetId: number | null;
  cachedSummary?: string;
  cachedMetadata?: TransparencyMetadata | null;
  cachedStaleAt?: string | null;
  hasAuth: boolean;
  tier?: SubscriptionTier;
  cashHistory?: { balance: number; asOfDate: string }[];
  cashForecast?: { balance: number; asOfDate: string }[];
  sharing: ReturnType<typeof useDashboardSharing>;
  chartAsk: { text: string; nonce: number } | null;
  askBoxRef: RefObject<HTMLDivElement | null>;
  businessType?: BusinessProfile['businessType'] | null;
  teamSize?: BusinessProfile['teamSize'] | null;
  onStreamComplete: () => void;
}

export function DashboardInsights({
  datasetId,
  cachedSummary,
  cachedMetadata,
  cachedStaleAt,
  hasAuth,
  tier,
  cashHistory,
  cashForecast,
  sharing,
  chartAsk,
  askBoxRef,
  businessType,
  teamSize,
  onStreamComplete,
}: DashboardInsightsProps) {
  const isMobile = useIsMobile();
  const [transparencyOpen, setTransparencyOpen] = useState(false);
  const [metadata, setMetadata] = useState<TransparencyMetadata | null>(cachedMetadata ?? null);
  const trackingRef = useRef(false);

  const toggleTransparency = useCallback(() => {
    setTransparencyOpen((open) => {
      const nextOpen = !open;
      if (nextOpen && !trackingRef.current) {
        trackingRef.current = true;
        trackClientEvent(ANALYTICS_EVENTS.TRANSPARENCY_PANEL_OPENED, { datasetId });
        setTimeout(() => {
          trackingRef.current = false;
        }, 300);
      }
      return nextOpen;
    });
  }, [datasetId]);

  const closeTransparency = useCallback(() => setTransparencyOpen(false), []);
  const handleMetadataReady = useCallback(
    (nextMetadata: TransparencyMetadata | null) => setMetadata(nextMetadata),
    [],
  );

  const summaryCard = (
    <AiSummaryCard
      datasetId={datasetId}
      cachedContent={cachedSummary}
      cachedMetadata={cachedMetadata}
      cachedStaleAt={cachedStaleAt}
      hasAuth={hasAuth}
      tier={tier}
      onToggleTransparency={toggleTransparency}
      transparencyOpen={transparencyOpen}
      onMetadataReady={handleMetadataReady}
      onStreamComplete={onStreamComplete}
      onShare={sharing.generatePng}
      onShareDownload={sharing.downloadPng}
      onShareCopy={sharing.copyToClipboard}
      shareState={sharing.shareStatus}
      onShareCopyLink={sharing.copyLink}
      shareLinkStatus={sharing.linkStatus}
      shareLinkClipboardFailed={sharing.linkClipboardFailed}
      onExportPdf={sharing.exportPdf}
      pdfStatus={sharing.pdfStatus}
      cashHistory={cashHistory}
      cashForecast={cashForecast}
    />
  );

  return (
    <>
      <AiSummaryErrorBoundary>
        {isMobile ? (
          <div>
            {summaryCard}
            <Sheet open={transparencyOpen} onOpenChange={(open) => !open && closeTransparency()}>
              <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-xl">
                <SheetTitle className="sr-only">How I reached this conclusion</SheetTitle>
                <TransparencyPanel
                  metadata={metadata}
                  isOpen={transparencyOpen}
                  onClose={closeTransparency}
                />
              </SheetContent>
            </Sheet>
          </div>
        ) : (
          <div>
            <div
              className={cn(
                'grid transition-[grid-template-columns] duration-200 ease-in-out motion-reduce:duration-0',
                transparencyOpen ? 'grid-cols-[1fr_320px] gap-6' : 'grid-cols-[1fr_0fr]',
              )}
            >
              {summaryCard}
              <TransparencyPanel
                metadata={metadata}
                isOpen={transparencyOpen}
                onClose={closeTransparency}
                className="overflow-hidden min-w-0"
              />
            </div>
          </div>
        )}
        {/* One mount point prevents a hydration-time mobile/desktop flip from
            firing the indicator's request twice. */}
        <div className="mt-2 px-1">
          <LastDigestIndicator enabled={hasAuth} />
        </div>
      </AiSummaryErrorBoundary>

      <AiSummaryErrorBoundary className="mt-6">
        <div ref={askBoxRef}>
          <QaAskBox
            datasetId={datasetId}
            metadata={metadata}
            askFromChart={chartAsk}
            hasAuth={hasAuth}
          />
        </div>
        <IndustryBenchmark businessType={businessType} teamSize={teamSize} className="mt-6" />
      </AiSummaryErrorBoundary>
    </>
  );
}
