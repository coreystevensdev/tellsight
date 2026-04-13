'use client';

import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { Upload, Filter } from 'lucide-react';
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

interface DashboardShellProps {
  initialData: ChartData;
  cachedSummary?: string;
  cachedMetadata?: TransparencyMetadata | null;
  tier?: SubscriptionTier;
}

const EMPTY_FILTERS: FilterState = { datePreset: null, category: null };

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

function EmptyState() {
  return (
    <div className="col-span-full flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
      <Upload className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No data to display</p>
      <Link
        href="/upload"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Upload a CSV
      </Link>
    </div>
  );
}

function FilteredEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="col-span-full flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
      <Filter className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No data matches these filters</p>
      <button
        type="button"
        onClick={onReset}
        className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        Reset filters
      </button>
    </div>
  );
}

export function DashboardShell({ initialData, cachedSummary, cachedMetadata, tier: serverTier }: DashboardShellProps) {
  const router = useRouter();
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
  const hasActiveFilters = filters.datePreset !== null || filters.category !== null;

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

  const aiSummaryCard = (
    <AiSummaryCard
      datasetId={data.datasetId}
      cachedContent={cachedSummary}
      cachedMetadata={cachedMetadata}
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
    />
  );

  return (
    <>
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
        <div className="mb-6">
          <h1 id="dashboard-heading" className="text-2xl font-semibold text-foreground">{data.orgName}</h1>
          {data.dateRange && (
            <p className="mt-1 text-sm text-muted-foreground">
              {data.dateRange.min} to {data.dateRange.max}
            </p>
          )}
        </div>

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
              </>
            )}
          </ChartErrorBoundary>

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
