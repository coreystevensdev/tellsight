'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ChartData, SubscriptionTier, TransparencyMetadata } from 'shared/types';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { trackClientEvent } from '@/lib/analytics';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useSubscription } from '@/lib/hooks/useSubscription';
import { useDashboardFinancials } from '@/lib/hooks/useDashboardFinancials';
import { useDashboardSharing } from '@/lib/hooks/useDashboardSharing';
import { useSidebar } from './SidebarContext';
import { DashboardCharts } from './DashboardCharts';
import { FilterBar } from './FilterBar';
import { useDashboardData } from './useDashboardData';
import { questionForChartPoint, type ChartPoint } from './suggestedQuestions';
import { IndustryBenchmark } from '@/components/IndustryBenchmark';
import type { BusinessProfile } from 'shared/schemas';
import { AiSummaryCard } from './AiSummaryCard';
import { QaAskBox } from './QaAskBox';
import { AiSummaryErrorBoundary } from './AiSummaryErrorBoundary';
import { TransparencyPanel } from './TransparencyPanel';
import { ShareFab } from './ShareMenu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { DemoModeBanner } from '@/components/common/DemoModeBanner';
import { KpiCards } from './KpiCards';
import { OnboardingModal } from './OnboardingModal';
import { DatasetChip } from '@/components/DatasetChip';
import { ConnectorReturnToast } from './ConnectorReturnToast';
import { LockedInsightCard } from './LockedInsightCard';
import { CashBalanceStaleBanner } from './CashBalanceStaleBanner';
import { DigestPausingBanner } from './DigestPausingBanner';
import { DigestClickTracker } from './DigestClickTracker';
import { AlertClickTracker } from './AlertClickTracker';
import { LastDigestIndicator } from '@/components/LastDigestIndicator';

interface DashboardShellProps {
  initialData: ChartData;
  // True when the charts request failed rather than came back empty. Without
  // it the empty-state banner claims the account has no data.
  chartsUnavailable?: boolean;
  cachedSummary?: string;
  cachedMetadata?: TransparencyMetadata | null;
  cachedStaleAt?: string | null;
  tier?: SubscriptionTier;
  needsOnboarding?: boolean;
  businessType?: BusinessProfile['businessType'] | null;
  teamSize?: BusinessProfile['teamSize'] | null;
}

export function DashboardShell({
  initialData,
  chartsUnavailable = false,
  cachedSummary,
  cachedMetadata,
  cachedStaleAt,
  tier: serverTier,
  needsOnboarding,
  businessType,
  teamSize,
}: DashboardShellProps) {
  const router = useRouter();
  const [showOnboarding, setShowOnboarding] = useState(needsOnboarding ?? false);
  const { setOrgName } = useSidebar();
  const isMobile = useIsMobile();
  const hasAuth = serverTier !== undefined;
  const { tier } = useSubscription({ enabled: hasAuth, fallbackData: serverTier });

  const prevTierRef = useRef(tier);
  useEffect(() => {
    if (prevTierRef.current === 'pro' && tier === 'free') {
      toast.warning("Your Pro subscription has ended. You're now on the free plan.");
    }
    prevTierRef.current = tier;
  }, [tier]);

  const {
    data,
    isLoading,
    mutate,
    filters,
    applyFilters,
    resetFilters,
    hasData,
    hasAnyData,
    hasActiveFilters,
  } = useDashboardData(initialData);
  // A chart click composes a question and hands it to the ask box. The nonce
  // rises every time so clicking the same bar twice asks twice; the box keys off
  // it rather than off the text.
  const [chartAsk, setChartAsk] = useState<{ text: string; nonce: number } | null>(null);
  const askBoxRef = useRef<HTMLDivElement>(null);

  const askAboutChartPoint = useCallback((point: ChartPoint) => {
    setChartAsk((prev) => ({ text: questionForChartPoint(point), nonce: (prev?.nonce ?? 0) + 1 }));
    // The ask box sits below the charts, so without this the answer arrives off
    // screen and the click looks like it did nothing.
    askBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const [transparencyOpen, setTransparencyOpen] = useState(false);
  const [metadata, setMetadata] = useState<TransparencyMetadata | null>(cachedMetadata ?? null);
  const firedRef = useRef(false);
  useEffect(() => {
    setOrgName(data.orgName);
  }, [data.orgName, setOrgName]);

  const handleUploadClick = useCallback(() => {
    router.push('/upload');
  }, [router]);

  const toggleTransparency = useCallback(() => {
    setTransparencyOpen((prev) => {
      const opening = !prev;
      if (opening && !firedRef.current) {
        firedRef.current = true;
        trackClientEvent(ANALYTICS_EVENTS.TRANSPARENCY_PANEL_OPENED, {
          datasetId: data.datasetId,
        });
        // reset after a tick to allow re-firing on future opens
        setTimeout(() => {
          firedRef.current = false;
        }, 300);
      }
      return opening;
    });
  }, [data.datasetId]);

  const handleCloseTransparency = useCallback(() => {
    setTransparencyOpen(false);
  }, []);

  const handleMetadataReady = useCallback((meta: TransparencyMetadata | null) => {
    setMetadata(meta);
  }, []);

  const [aiDone, setAiDone] = useState(false);
  const handleStreamComplete = useCallback(() => setAiDone(true), []);

  const captureRef = useRef<HTMLDivElement>(null);
  const {
    shareStatus,
    generatePng,
    downloadPng,
    copyToClipboard,
    copyLink,
    linkStatus,
    linkClipboardFailed,
    exportPdf,
    pdfStatus,
  } = useDashboardSharing(captureRef, data.datasetId);

  const {
    cashAsOfDate,
    cashHistory,
    cashForecast,
    needsCashBalance,
    hasBalance,
    needsBreakEvenEnable,
    saveCashBalance,
    saveMonthlyFixedCosts,
  } = useDashboardFinancials({
    hasAuth,
    hasAnyData,
    hasMarginSignal: data.hasMarginSignal === true,
    onSaved: router.refresh,
  });

  const aiSummaryCard = (
    <AiSummaryCard
      datasetId={data.datasetId}
      cachedContent={cachedSummary}
      cachedMetadata={cachedMetadata}
      cachedStaleAt={cachedStaleAt}
      hasAuth={hasAuth}
      tier={tier}
      onToggleTransparency={toggleTransparency}
      transparencyOpen={transparencyOpen}
      onMetadataReady={handleMetadataReady}
      onStreamComplete={handleStreamComplete}
      onShare={generatePng}
      onShareDownload={downloadPng}
      onShareCopy={copyToClipboard}
      shareState={shareStatus}
      onShareCopyLink={copyLink}
      shareLinkStatus={linkStatus}
      shareLinkClipboardFailed={linkClipboardFailed}
      onExportPdf={exportPdf}
      pdfStatus={pdfStatus}
      cashHistory={cashHistory}
      cashForecast={cashForecast}
    />
  );

  return (
    <>
      {/* useSearchParams is request-time data, keep these leaves under Suspense
          so the rest of the shell stays statically renderable under Next.js
          16. One shared boundary, not one per leaf, three independently-
          resolving Suspense boundaries can resolve in a different order
          during SSR streaming than during client hydration, and React's
          useId() numbering depends on that order, three separate boundaries
          around always-return-null leaves caused a real id mismatch
          downstream (QaAskBox's label/input pair) even though none of these
          three ever render visible DOM themselves. */}
      <Suspense fallback={null}>
        <ConnectorReturnToast />
        <DigestClickTracker />
        <AlertClickTracker />
      </Suspense>
      {showOnboarding && <OnboardingModal onComplete={() => setShowOnboarding(false)} />}
      {chartsUnavailable ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 md:px-6 lg:px-8"
        >
          <p className="text-sm text-foreground">
            Your dashboard data could not be loaded. This is not an empty account, so reload in a
            moment rather than uploading anything.
          </p>
        </div>
      ) : (
        <DemoModeBanner demoState={data.demoState} onUploadClick={handleUploadClick} />
      )}

      {isLoading && hasAnyData && !hasData ? (
        <div
          className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3 md:px-6 lg:px-8"
          role="status"
          aria-label="Loading filters"
          data-testid="filter-bar-skeleton"
        >
          <div className="h-9 w-[120px] rounded-full bg-muted animate-skeleton-pulse motion-reduce:animate-none" />
          <div className="h-9 w-[120px] rounded-full bg-muted animate-skeleton-pulse motion-reduce:animate-none" />
          <div className="h-9 w-[80px] rounded-md bg-muted animate-skeleton-pulse motion-reduce:animate-none" />
        </div>
      ) : hasAnyData ? (
        <FilterBar
          filters={filters}
          onFilterChange={applyFilters}
          availableCategories={data.availableCategories ?? []}
        />
      ) : null}

      {/* pb-24 on mobile: clears the fixed ShareFab (bottom-4, 48px tall) so it
          doesn't sit on top of the page's last interactive element. Desktop
          has no FAB, so pb-16 is enough there. */}
      <section
        className="mx-auto max-w-7xl px-4 pt-6 pb-24 md:px-6 md:pb-16 lg:px-8"
        aria-labelledby="dashboard-heading"
      >
        {hasData && (
          <div className="mb-6">
            <h1 id="dashboard-heading" className="font-serif text-3xl font-medium text-foreground">
              {data.orgName}
            </h1>
            {data.dateRange && (
              <p className="mt-1 text-sm text-muted-foreground">
                {data.dateRange.min} to {data.dateRange.max}
              </p>
            )}
            {hasAuth && data.datasetName && (
              <DatasetChip name={data.datasetName} rowCount={data.datasetRowCount ?? 0} />
            )}
          </div>
        )}

        <div ref={captureRef}>
          {hasData && (
            <KpiCards revenueTrend={data.revenueTrend} expenseBreakdown={data.expenseBreakdown} />
          )}

          <DashboardCharts
            data={data}
            isLoading={isLoading}
            hasActiveFilters={hasActiveFilters}
            onRetry={() => mutate()}
            onResetFilters={resetFilters}
            onAskAboutPoint={askAboutChartPoint}
          />

          {/* The summary describes the charts, so it follows them. FR24 was
              amended for this: its acquisition rationale is the shared-link
              view at /share/[token], which renders the summary alone with no
              charts and is untouched by this ordering. */}
          <AiSummaryErrorBoundary>
            {isMobile ? (
              <div>
                {aiSummaryCard}
                <Sheet
                  open={transparencyOpen}
                  onOpenChange={(open) => !open && handleCloseTransparency()}
                >
                  <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-xl">
                    <SheetTitle className="sr-only">How I reached this conclusion</SheetTitle>
                    <TransparencyPanel
                      metadata={metadata}
                      isOpen={transparencyOpen}
                      onClose={handleCloseTransparency}
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
                  {aiSummaryCard}
                  <TransparencyPanel
                    metadata={metadata}
                    isOpen={transparencyOpen}
                    onClose={handleCloseTransparency}
                    className="overflow-hidden min-w-0"
                  />
                </div>
              </div>
            )}
            {/* Single mount point, lifted above the mobile/desktop branch so a
                useIsMobile flip after hydration doesn't double-fire the indicator's
                fetch. SWR dedupe inside the component handles repeated mounts
                across navigations. */}
            <div className="mt-2 px-1">
              <LastDigestIndicator enabled={hasAuth} />
            </div>
          </AiSummaryErrorBoundary>

          <AiSummaryErrorBoundary className="mt-6">
            <div ref={askBoxRef}>
              <QaAskBox
                datasetId={data.datasetId}
                metadata={metadata}
                askFromChart={chartAsk}
                hasAuth={hasAuth}
              />
            </div>

            {/* After the interpretation, not beside the KPIs: these are someone
                else's numbers and should not read as one of yours. */}
            <IndustryBenchmark businessType={businessType} teamSize={teamSize} className="mt-6" />
          </AiSummaryErrorBoundary>

          {hasAnyData && hasBalance && (
            <CashBalanceStaleBanner
              cashAsOfDate={cashAsOfDate}
              onUpdate={saveCashBalance}
              className="mt-6"
            />
          )}

          {/* Signed-in only: the digest is a Pro feature and the seed dashboard
              has no org whose digest could pause. */}
          {hasAuth && <DigestPausingBanner digestPausesAt={data.digestPausesAt} className="mt-6" />}

          {needsCashBalance && (
            <LockedInsightCard
              title="Enable Runway"
              description="Add your current cash balance to see how many months of runway you have at your current burn rate."
              inputLabel="Current cash balance"
              onSubmit={saveCashBalance}
              className="mt-6"
            />
          )}

          {needsBreakEvenEnable && (
            <LockedInsightCard
              title="Enable Break-Even Analysis"
              description="Add your monthly fixed costs to see the revenue you need to cover them at your current margin."
              inputLabel="Monthly fixed costs"
              inputMask="currency"
              inputMax={9_999_999}
              onSubmit={saveMonthlyFixedCosts}
              className="mt-6"
            />
          )}
        </div>

        <ShareFab
          visible={hasData && aiDone}
          status={shareStatus}
          onGenerate={generatePng}
          onDownload={downloadPng}
          onCopy={copyToClipboard}
          onCopyLink={copyLink}
          linkStatus={linkStatus}
          linkClipboardFailed={linkClipboardFailed}
          onExportPdf={exportPdf}
          pdfStatus={pdfStatus}
        />
      </section>
    </>
  );
}
