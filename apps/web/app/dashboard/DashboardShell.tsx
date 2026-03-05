'use client';

import { Component, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { Upload, Filter } from 'lucide-react';
import type { ChartData } from 'shared/types';
import { apiClient } from '@/lib/api-client';
import { useSidebar } from './contexts/SidebarContext';
import { RevenueChart } from './charts/RevenueChart';
import { ExpenseChart } from './charts/ExpenseChart';
import { ChartSkeleton } from './charts/ChartSkeleton';
import { LazyChart } from './charts/LazyChart';
import { FilterBar, computeDateRange, type FilterState } from './FilterBar';
import { AiSummarySkeleton } from './AiSummarySkeleton';
import { DemoModeBanner } from '@/components/common/DemoModeBanner';

interface DashboardShellProps {
  initialData: ChartData;
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

export function DashboardShell({ initialData }: DashboardShellProps) {
  const router = useRouter();
  const { setOrgName } = useSidebar();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
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

  const hasRevenue = data.revenueTrend.length > 0;
  const hasExpenses = data.expenseBreakdown.length > 0;
  const hasData = hasRevenue || hasExpenses;
  const hasAnyData = initialData.revenueTrend.length > 0 || initialData.expenseBreakdown.length > 0;

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
        </div>

        {isLoading && !hasData && <AiSummarySkeleton className="mb-6" />}

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
          )}
        </ChartErrorBoundary>
      </section>
    </>
  );
}
