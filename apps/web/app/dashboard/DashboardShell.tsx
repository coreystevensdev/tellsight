'use client';

import { Component, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { Filter } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ChartData, SubscriptionTier, TransparencyMetadata } from 'shared/types';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { apiClient } from '@/lib/api-client';
import { trackClientEvent } from '@/lib/analytics';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useSubscription } from '@/lib/hooks/useSubscription';
import { useSidebar } from './contexts/SidebarContext';
import { RevenueChart } from './charts/RevenueChart';
import { ExpenseChart } from './charts/ExpenseChart';
import { ExpenseTrendChart } from './charts/ExpenseTrendChart';
import { RevenueVsExpensesChart } from './charts/RevenueVsExpensesChart';
import { ProfitMarginChart } from './charts/ProfitMarginChart';
import { YoyChart } from './charts/YoyChart';
import { ChartSkeleton } from './charts/ChartSkeleton';
import { LazyChart } from './charts/LazyChart';
import { FilterBar, computeDateRange, type FilterState } from './FilterBar';
import { AiSummaryCard } from './AiSummaryCard';
import { AiSummaryErrorBoundary } from './AiSummaryErrorBoundary';
import { TransparencyPanel } from './TransparencyPanel';
import { ShareFab } from './ShareMenu';
import { useShareInsight } from '@/lib/hooks/useShareInsight';
import { useCreateShareLink } from '@/lib/hooks/useCreateShareLink';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { DemoModeBanner } from '@/components/common/DemoModeBanner';
import { useExportPdf } from '@/lib/hooks/useExportPdf';
import { KpiCards } from './KpiCards';
import { OnboardingModal } from './OnboardingModal';
import { DatasetChip } from '@/components/datasets/DatasetChip';
import { QbReturnToast } from './QbReturnToast';
import { LockedInsightCard } from './LockedInsightCard';
import { CashBalanceStaleBanner } from './CashBalanceStaleBanner';
import type { OrgFinancials } from 'shared/types';

interface DashboardShellProps {
  initialData: ChartData;
  cachedSummary?: string;
  cachedMetadata?: TransparencyMetadata | null;
  cachedStaleAt?: string | null;
  tier?: SubscriptionTier;
  needsOnboarding?: boolean;
}

const EMPTY_FILTERS: FilterState = { datePreset: null, category: null, granularity: 'monthly' };

function buildSwrKey(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.datePreset) {
    const range = computeDateRange(filters.datePreset);
    if (range) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
  }
  if (filters.category) {
    params.set('categories', filters.category);
  }
  if (filters.granularity && filters.granularity !== 'monthly') {
    params.set('granularity', filters.granularity);
  }
  const qs = params.toString();
  return qs ? `/dashboard/charts?${qs}` : '/dashboard/charts';
}

async function fetchChartData(key: string): Promise<ChartData> {
  const path = key.startsWith('/') ? key : `/${key}`;
  const res = await apiClient<ChartData>(path);
  return res.data;
}

class ChartErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="col-span-full flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">Unable to load charts</p>
          <button
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onRetry();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function EmptyStateIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="mb-1">
      {/* stylized CSV file with upward arrow */}
      <rect x="14" y="8" width="28" height="36" rx="3" className="stroke-muted-foreground/40" strokeWidth="1.5" fill="none" />
      <line x1="20" y1="18" x2="36" y2="18" className="stroke-muted-foreground/30" strokeWidth="1.5" />
      <line x1="20" y1="24" x2="32" y2="24" className="stroke-muted-foreground/30" strokeWidth="1.5" />
      <line x1="20" y1="30" x2="34" y2="30" className="stroke-muted-foreground/30" strokeWidth="1.5" />
      {/* arrow */}
      <path d="M42 52 L42 38 M36 44 L42 38 L48 44" className="stroke-primary" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* insight dot */}
      <circle cx="48" cy="14" r="4" className="fill-accent-warm/60" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="col-span-full flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/30 p-8 text-center">
      <EmptyStateIllustration />
      <p className="text-sm font-medium text-foreground">Your data is waiting</p>
      <p className="max-w-[260px] text-sm text-muted-foreground">
        Drop a CSV and we&apos;ll turn it into charts and plain-English insights
      </p>
      <Link
        href="/upload"
        className="mt-3 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Upload a CSV
      </Link>
    </div>
  );
}

function FilteredEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="col-span-full flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/30 p-8 text-center">
      <Filter className="mb-1 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm font-medium text-foreground">Nothing here for those filters</p>
      <p className="max-w-[260px] text-sm text-muted-foreground">
        Try a wider date range or clear the category filter
      </p>
      <button
        type="button"
        onClick={onReset}
        className="mt-3 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        Reset filters
      </button>
    </div>
  );
}

export function DashboardShell({ initialData, cachedSummary, cachedMetadata, cachedStaleAt, tier: serverTier, needsOnboarding }: DashboardShellProps) {
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

  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [transparencyOpen, setTransparencyOpen] = useState(false);
  const [metadata, setMetadata] = useState<TransparencyMetadata | null>(cachedMetadata ?? null);
  const firedRef = useRef(false);
  const swrKey = buildSwrKey(filters);
  const hasActiveFilters = filters.datePreset !== null || filters.category !== null || filters.granularity !== 'monthly';

  const { data = initialData, isLoading, mutate } = useSWR(
    swrKey,
    fetchChartData,
    {
      fallbackData: initialData,
      revalidateOnFocus: true,
      revalidateOnReconnect: false,
      keepPreviousData: true,
    },
  );

  useEffect(() => {
    setOrgName(data.orgName);
  }, [data.orgName, setOrgName]);

  const handleFilterChange = useCallback((next: FilterState) => {
    setFilters(next);
  }, []);

  const handleResetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  const handleUploadClick = useCallback(() => {
    router.push('/upload');
  }, [router]);

  const handleToggleTransparency = useCallback(() => {
    setTransparencyOpen((prev) => {
      const opening = !prev;
      if (opening && !firedRef.current) {
        firedRef.current = true;
        trackClientEvent(ANALYTICS_EVENTS.TRANSPARENCY_PANEL_OPENED, {
          datasetId: data.datasetId,
        });
        // reset after a tick to allow re-firing on future opens
        setTimeout(() => { firedRef.current = false; }, 300);
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
  const { status: shareStatus, generatePng, downloadPng, copyToClipboard } = useShareInsight(captureRef);
  const { status: linkStatus, clipboardFailed: linkClipboardFailed, createLink } = useCreateShareLink();
  const { status: pdfStatus, exportPdf } = useExportPdf(captureRef);

  const handleCopyLink = useCallback(async () => {
    if (data.datasetId != null) await createLink(data.datasetId);
  }, [data.datasetId, createLink]);

  const hasRevenue = data.revenueTrend.length > 0;
  const hasExpenses = data.expenseBreakdown.length > 0;
  const hasData = hasRevenue || hasExpenses;
  const hasAnyData = initialData.revenueTrend.length > 0 || initialData.expenseBreakdown.length > 0;

  const { data: financials, mutate: refreshFinancials } = useSWR<OrgFinancials>(
    hasAnyData ? '/org/financials' : null,
    async (key: string) => (await apiClient<OrgFinancials>(key)).data,
    { revalidateOnFocus: false },
  );

  // Cash history feeds the runway thumbnail in Story 8.5. We only fetch once
  // the user has data (demo mode datasets get no runway anyway) and only when
  // they've saved at least one balance (no history = no chart).
  const { data: cashHistory } = useSWR<{ balance: number; asOfDate: string }[]>(
    hasAnyData && financials?.cashOnHand != null ? '/org/financials/cash-history?limit=24' : null,
    async (key: string) => (await apiClient<{ balance: number; asOfDate: string }[]>(key)).data,
    { revalidateOnFocus: false },
  );

  // Gate on `financials !== undefined` so the Locked Insight card doesn't flash
  // during initial SWR fetch for users who already have a cash balance set.
  const needsCashBalance = hasAnyData && financials !== undefined && !financials.cashOnHand;
  const hasBalance = !!financials?.cashAsOfDate;
  const needsBreakEvenEnable = hasAnyData
    && data.hasMarginSignal === true
    && financials !== undefined
    && financials.monthlyFixedCosts == null;

  async function saveCashBalance(value: number) {
    await apiClient('/org/financials', {
      method: 'PUT',
      body: JSON.stringify({ cashOnHand: value }),
    });
    await refreshFinancials();
    router.refresh();
  }

  async function saveMonthlyFixedCosts(value: number) {
    await apiClient('/org/financials', {
      method: 'PUT',
      body: JSON.stringify({ monthlyFixedCosts: value }),
    });
    await refreshFinancials();
    router.refresh();
  }

  const aiSummaryCard = (
    <AiSummaryCard
      datasetId={data.datasetId}
      cachedContent={cachedSummary}
      cachedMetadata={cachedMetadata}
      cachedStaleAt={cachedStaleAt}
      tier={tier}
      onToggleTransparency={handleToggleTransparency}
      transparencyOpen={transparencyOpen}
      onMetadataReady={handleMetadataReady}
      onStreamComplete={handleStreamComplete}
      onShare={generatePng}
      onShareDownload={downloadPng}
      onShareCopy={copyToClipboard}
      shareState={shareStatus}
      onShareCopyLink={handleCopyLink}
      shareLinkStatus={linkStatus}
      shareLinkClipboardFailed={linkClipboardFailed}
      onExportPdf={exportPdf}
      pdfStatus={pdfStatus}
      cashHistory={cashHistory}
    />
  );

  return (
    <>
      {/* useSearchParams is request-time data — keep it in a leaf under Suspense so
          the rest of the shell stays statically renderable under Next.js 16. */}
      <Suspense fallback={null}>
        <QbReturnToast />
      </Suspense>
      {showOnboarding && <OnboardingModal onComplete={() => setShowOnboarding(false)} />}
      <DemoModeBanner demoState={data.demoState} onUploadClick={handleUploadClick} />

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
          onFilterChange={handleFilterChange}
          availableCategories={data.availableCategories ?? []}
        />
      ) : null}

      <section className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:px-8" aria-labelledby="dashboard-heading">
        {hasData && (
          <div className="mb-6">
            <h1 id="dashboard-heading" className="text-2xl font-semibold text-foreground">{data.orgName}</h1>
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
            <KpiCards
              revenueTrend={data.revenueTrend}
              expenseBreakdown={data.expenseBreakdown}
            />
          )}

          <ChartErrorBoundary onRetry={() => mutate()}>
            {isLoading && !hasData ? (
              <div className="grid gap-4 md:grid-cols-2 md:gap-6">
                <ChartSkeleton variant="line" />
                <ChartSkeleton variant="bar" />
              </div>
            ) : !hasData && hasActiveFilters ? (
              <FilteredEmptyState onReset={handleResetFilters} />
            ) : !hasData ? (
              <EmptyState />
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 md:gap-6">
                  {hasRevenue && (
                    <LazyChart skeletonVariant="line">
                      <RevenueChart data={data.revenueTrend} />
                    </LazyChart>
                  )}
                  {hasExpenses && (
                    <LazyChart skeletonVariant="bar">
                      <ExpenseChart data={data.expenseBreakdown} />
                    </LazyChart>
                  )}
                </div>
                {data.monthlyComparison?.length > 0 && (
                  <div className="mt-4 grid gap-4 md:mt-6 md:grid-cols-2 md:gap-6">
                    <LazyChart skeletonVariant="line">
                      <RevenueVsExpensesChart data={data.monthlyComparison} />
                    </LazyChart>
                    <LazyChart skeletonVariant="line">
                      <ProfitMarginChart data={data.monthlyComparison} />
                    </LazyChart>
                  </div>
                )}
                {data.expenseTrend?.length > 0 && (
                  <div className="mt-4 md:mt-6">
                    <LazyChart skeletonVariant="line">
                      <ExpenseTrendChart
                        data={data.expenseTrend}
                        categories={data.availableCategories}
                      />
                    </LazyChart>
                  </div>
                )}
                {data.yoyComparison?.length > 0 && (
                  <div className="mt-4 md:mt-6">
                    <LazyChart skeletonVariant="bar">
                      <YoyChart data={data.yoyComparison} />
                    </LazyChart>
                  </div>
                )}
              </>
            )}
          </ChartErrorBoundary>

          {hasAnyData && hasBalance && (
            <CashBalanceStaleBanner
              cashAsOfDate={financials?.cashAsOfDate ?? null}
              onUpdate={saveCashBalance}
              className="mt-6"
            />
          )}

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

          <AiSummaryErrorBoundary className="mt-6">
            {isMobile ? (
              <div className="mt-6">
                {aiSummaryCard}
                <Sheet open={transparencyOpen} onOpenChange={(open) => !open && handleCloseTransparency()}>
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
              <div className="mt-6">
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
          </AiSummaryErrorBoundary>
        </div>

        <ShareFab
          visible={hasData && aiDone}
          status={shareStatus}
          onGenerate={generatePng}
          onDownload={downloadPng}
          onCopy={copyToClipboard}
          onCopyLink={handleCopyLink}
          linkStatus={linkStatus}
          linkClipboardFailed={linkClipboardFailed}
          onExportPdf={exportPdf}
          pdfStatus={pdfStatus}
        />
      </section>
    </>
  );
}
