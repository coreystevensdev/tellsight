'use client';

import { TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Scale, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RevenueTrendPoint, ExpenseBreakdownItem } from 'shared/types';

interface KpiCardsProps {
  revenueTrend: RevenueTrendPoint[];
  expenseBreakdown: ExpenseBreakdownItem[];
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function KpiCard({ label, value, icon: Icon, trend, iconColor }: {
  label: string;
  value: string;
  icon: typeof ArrowUpRight;
  trend?: { value: number; label: string } | null;
  iconColor: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md hover:border-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon className={cn('h-4 w-4', iconColor)} />
      </div>
      <p
        className="mt-2 text-2xl font-bold text-card-foreground"
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </p>
      {trend && trend.value !== 0 && (
        <div className="mt-1 flex items-center gap-1">
          {trend.value > 0 ? (
            <TrendingUp className="h-3 w-3 text-success" />
          ) : (
            <TrendingDown className="h-3 w-3 text-destructive" />
          )}
          <span
            className={cn(
              'text-xs font-medium',
              trend.value > 0 ? 'text-success' : 'text-destructive',
            )}
          >
            {trend.value > 0 ? '+' : ''}{Math.round(trend.value)}%
          </span>
          <span className="text-xs text-muted-foreground">{trend.label}</span>
        </div>
      )}
    </div>
  );
}

export function KpiCards({ revenueTrend, expenseBreakdown }: KpiCardsProps) {
  if (revenueTrend.length === 0 && expenseBreakdown.length === 0) return null;

  const totalRevenue = revenueTrend.reduce((sum, r) => sum + r.revenue, 0);
  const totalExpenses = expenseBreakdown.reduce((sum, e) => sum + e.total, 0);
  const netProfit = totalRevenue - totalExpenses;
  const topCategory = expenseBreakdown[0];

  const revenueTrend12 = revenueTrend.length >= 2
    ? (() => {
        const last = revenueTrend[revenueTrend.length - 1]!.revenue;
        const prev = revenueTrend[revenueTrend.length - 2]!.revenue;
        return prev > 0 ? ((last - prev) / prev) * 100 : null;
      })()
    : null;

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      <KpiCard
        label="Total Revenue"
        value={formatCompact(totalRevenue)}
        icon={ArrowUpRight}
        iconColor="text-success"
        trend={revenueTrend12 != null ? { value: revenueTrend12, label: 'vs prev month' } : null}
      />
      <KpiCard
        label="Total Expenses"
        value={formatCompact(totalExpenses)}
        icon={ArrowDownRight}
        iconColor="text-destructive"
      />
      <KpiCard
        label="Net Profit"
        value={formatCompact(netProfit)}
        icon={Scale}
        iconColor={netProfit >= 0 ? 'text-success' : 'text-destructive'}
      />
      <KpiCard
        label="Top Expense"
        value={topCategory ? topCategory.category : 'N/A'}
        icon={Tag}
        iconColor="text-muted-foreground"
      />
    </div>
  );
}
