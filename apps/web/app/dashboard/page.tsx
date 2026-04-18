import { cookies } from 'next/headers';
import type { ChartData, SubscriptionTier, TransparencyMetadata } from 'shared/types';
import { apiServer, ApiServerError } from '@/lib/api-server';
import { AUTH } from 'shared/constants';
import { DashboardShell } from './DashboardShell';

const EMPTY_CHART_DATA: ChartData = {
  revenueTrend: [],
  expenseBreakdown: [],
  expenseTrend: [],
  monthlyComparison: [],
  yoyComparison: [],
  orgName: 'Dashboard',
  isDemo: true,
  availableCategories: [],
  dateRange: null,
  demoState: 'empty',
  datasetId: null,
};

interface CachedSummaryResult {
  content: string;
  metadata: TransparencyMetadata | null;
  staleAt: string | null;
}

async function fetchCachedSummary(datasetId: number): Promise<CachedSummaryResult | undefined> {
  try {
    const res = await apiServer<{
      content: string;
      metadata: TransparencyMetadata | null;
      staleAt?: string | null;
    }>(`/ai-summaries/${datasetId}/cached`);
    return {
      content: res.data.content,
      metadata: res.data.metadata,
      staleAt: res.data.staleAt ?? null,
    };
  } catch {
    return undefined;
  }
}

async function fetchLatestSummary(
  datasetId: number,
  cookieHeader: string,
): Promise<CachedSummaryResult | undefined> {
  try {
    const res = await apiServer<{
      content: string;
      metadata: TransparencyMetadata | null;
      staleAt?: string | null;
    }>(`/ai-summaries/${datasetId}/latest`, { cookies: cookieHeader });
    return {
      content: res.data.content,
      metadata: res.data.metadata,
      staleAt: res.data.staleAt ?? null,
    };
  } catch {
    // 404 (no summary yet) or other failure — caller falls back to streaming
    return undefined;
  }
}

async function fetchTier(cookieHeader: string): Promise<SubscriptionTier> {
  try {
    const res = await apiServer<{ tier: SubscriptionTier }>('/subscriptions/tier', {
      cookies: cookieHeader,
    });
    return res.data.tier;
  } catch {
    return 'free';
  }
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const hasAuth = cookieStore.has(AUTH.COOKIE_NAMES.ACCESS_TOKEN);

  let chartData: ChartData;
  try {
    const res = await apiServer<ChartData>('/dashboard/charts', {
      cookies: cookieHeader,
    });
    chartData = res.data;
  } catch (err) {
    if (err instanceof ApiServerError) {
      chartData = EMPTY_CHART_DATA;
    } else {
      throw err;
    }
  }

  // Cached summary flows through the same props whether the user is anonymous
  // (seed org, public /cached) or authenticated (own org, protected /latest).
  // When the summary is stale, the card renders a refresh banner instead of
  // silently streaming — saves quota and lets the user choose.
  let cachedSummary: string | undefined;
  let cachedMetadata: TransparencyMetadata | null = null;
  let cachedStaleAt: string | null = null;
  if (chartData.datasetId) {
    const cached = hasAuth
      ? await fetchLatestSummary(chartData.datasetId, cookieHeader)
      : await fetchCachedSummary(chartData.datasetId);
    cachedSummary = cached?.content;
    cachedMetadata = cached?.metadata ?? null;
    cachedStaleAt = cached?.staleAt ?? null;
  }

  // authenticated users get tier-gated experience
  const tier = hasAuth ? await fetchTier(cookieHeader) : undefined;

  let needsOnboarding = false;
  if (hasAuth) {
    try {
      const res = await apiServer<unknown>('/org/profile', { cookies: cookieHeader });
      needsOnboarding = res.data === null;
    } catch {
      needsOnboarding = false;
    }
  }

  return (
    <DashboardShell
      initialData={chartData}
      cachedSummary={cachedSummary}
      cachedMetadata={cachedMetadata}
      cachedStaleAt={cachedStaleAt}
      tier={tier}
      needsOnboarding={needsOnboarding}
    />
  );
}
