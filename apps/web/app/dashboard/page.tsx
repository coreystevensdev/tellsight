import { cookies } from 'next/headers';
import type { ChartData, SubscriptionTier, TransparencyMetadata } from 'shared/types';
import { apiServer, ApiServerError } from '@/lib/api-server';
import { AUTH } from 'shared/constants';
import { DashboardShell } from './DashboardShell';

const EMPTY_CHART_DATA: ChartData = {
  revenueTrend: [],
  expenseBreakdown: [],
  expenseTrend: [],
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
}

async function fetchCachedSummary(datasetId: number): Promise<CachedSummaryResult | undefined> {
  try {
    const res = await apiServer<{ content: string; metadata: TransparencyMetadata | null }>(
      `/ai-summaries/${datasetId}/cached`,
    );
    return { content: res.data.content, metadata: res.data.metadata };
  } catch {
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

  // anonymous visitors get pre-cached seed AI summary (no streaming)
  // no tier gating — full seed summary is the "aha moment"
  let cachedSummary: string | undefined;
  let cachedMetadata: TransparencyMetadata | null = null;
  if (!hasAuth && chartData.datasetId) {
    const cached = await fetchCachedSummary(chartData.datasetId);
    cachedSummary = cached?.content;
    cachedMetadata = cached?.metadata ?? null;
  }

  // authenticated users get tier-gated experience
  const tier = hasAuth ? await fetchTier(cookieHeader) : undefined;

  return (
    <DashboardShell
      initialData={chartData}
      cachedSummary={cachedSummary}
      cachedMetadata={cachedMetadata}
      tier={tier}
    />
  );
}
