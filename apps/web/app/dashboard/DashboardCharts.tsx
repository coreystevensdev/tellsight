'use client';

import { Component, type ReactNode } from 'react';
import Link from 'next/link';
import { Filter } from 'lucide-react';
import type { ChartData } from 'shared/types';

import { ChartSkeleton } from './charts/ChartSkeleton';
import { ExpenseChart } from './charts/ExpenseChart';
import { ExpenseTrendChart } from './charts/ExpenseTrendChart';
import { LazyChart } from './charts/LazyChart';
import { ProfitMarginChart } from './charts/ProfitMarginChart';
import { RevenueChart } from './charts/RevenueChart';
import { RevenueVsExpensesChart } from './charts/RevenueVsExpensesChart';
import { YoyChart } from './charts/YoyChart';
import type { ChartPoint } from './suggestedQuestions';

interface DashboardChartsProps {
  data: ChartData;
  isLoading: boolean;
  hasActiveFilters: boolean;
  onRetry: () => void;
  onResetFilters: () => void;
  onAskAboutPoint: (point: ChartPoint) => void;
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
      <rect
        x="14"
        y="8"
        width="28"
        height="36"
        rx="3"
        className="stroke-muted-foreground/40"
        strokeWidth="1.5"
        fill="none"
      />
      <line
        x1="20"
        y1="18"
        x2="36"
        y2="18"
        className="stroke-muted-foreground/30"
        strokeWidth="1.5"
      />
      <line
        x1="20"
        y1="24"
        x2="32"
        y2="24"
        className="stroke-muted-foreground/30"
        strokeWidth="1.5"
      />
      <line
        x1="20"
        y1="30"
        x2="34"
        y2="30"
        className="stroke-muted-foreground/30"
        strokeWidth="1.5"
      />
      <path
        d="M42 52 L42 38 M36 44 L42 38 L48 44"
        className="stroke-primary"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="48" cy="14" r="4" className="fill-accent-warm/60" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="col-span-full mt-6 flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/30 p-8 text-center">
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
    <div className="col-span-full mt-6 flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/30 p-8 text-center">
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

export function DashboardCharts({
  data,
  isLoading,
  hasActiveFilters,
  onRetry,
  onResetFilters,
  onAskAboutPoint,
}: DashboardChartsProps) {
  const hasRevenue = data.revenueTrend.length > 0;
  const hasExpenses = data.expenseBreakdown.length > 0;
  const hasData = hasRevenue || hasExpenses;

  return (
    <ChartErrorBoundary onRetry={onRetry}>
      {isLoading && !hasData ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2 md:gap-6">
          <ChartSkeleton variant="line" />
          <ChartSkeleton variant="bar" />
        </div>
      ) : !hasData && hasActiveFilters ? (
        <FilteredEmptyState onReset={onResetFilters} />
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <>
          <div className="mt-6 grid gap-4 md:grid-cols-2 md:gap-6">
            {hasRevenue && (
              <LazyChart skeletonVariant="line">
                <RevenueChart
                  data={data.revenueTrend}
                  onPointClick={(month) => onAskAboutPoint({ chart: 'revenue', month })}
                />
              </LazyChart>
            )}
            {hasExpenses && (
              <LazyChart skeletonVariant="bar">
                <ExpenseChart
                  data={data.expenseBreakdown}
                  onCategoryClick={(category) => onAskAboutPoint({ chart: 'expense', category })}
                />
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
                <ExpenseTrendChart data={data.expenseTrend} categories={data.availableCategories} />
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
  );
}
