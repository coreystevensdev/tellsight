import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import type { ChartData } from 'shared/types';

import { apiClient } from '@/lib/api-client';
import { useDashboardData } from './useDashboardData';

vi.mock('@/lib/api-client', () => ({
  apiClient: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const DEMO: ChartData = {
  revenueTrend: [],
  expenseBreakdown: [],
  expenseTrend: [],
  monthlyComparison: [],
  yoyComparison: [],
  orgName: 'Sunrise Cafe',
  isDemo: true,
  availableCategories: [],
  dateRange: null,
  demoState: 'seed_only',
  datasetId: 1,
};

const OWN: ChartData = {
  ...DEMO,
  revenueTrend: [{ month: '2026-10', revenue: 4200 }],
  orgName: 'Corey Stevens Organization',
  isDemo: false,
  demoState: 'user_only',
  datasetId: 7,
};

// fresh SWR cache per test, prevents deduplication across tests
function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children,
  );
}

const mockApiClient = vi.mocked(apiClient);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDashboardData', () => {
  // api-client.test.ts proves apiClient recovers from a 401, and the API suite
  // proves the charts route sends one. Nothing joined them, so swapping this
  // fetcher to a bare fetch dropped the recovery with both suites still green.
  // This is the join.
  it('fetches charts through apiClient rather than fetch', async () => {
    mockApiClient.mockResolvedValue({ data: OWN });

    const { result } = renderHook(() => useDashboardData(DEMO), { wrapper });

    await waitFor(() => expect(mockApiClient).toHaveBeenCalled());
    expect(mockApiClient.mock.calls[0]?.[0]).toBe('/dashboard/charts');
    expect(result.current.data.isDemo).toBe(false);
  });

  // initialData is the server render's payload, which for a lapsed session is
  // the seed org. Once the client call resolves with the org's own data the
  // demo has to be gone rather than kept beside it.
  it('replaces the seed payload with the org data once the call resolves', async () => {
    mockApiClient.mockResolvedValue({ data: OWN });

    const { result } = renderHook(() => useDashboardData(DEMO), { wrapper });

    expect(result.current.data.orgName).toBe('Sunrise Cafe');

    await waitFor(() => expect(result.current.data.isDemo).toBe(false));
    expect(result.current.data.orgName).toBe('Corey Stevens Organization');
    expect(result.current.data.datasetId).toBe(7);
    expect(result.current.hasData).toBe(true);
  });

  // keepPreviousData is the point: a failed revalidation must not blank a chart
  // that was already on screen. The hook also drops SWR's error, so this is the
  // only observable either way, and anything added to surface that error has to
  // come back here rather than slip past.
  it('keeps the payload it already had when the call throws', async () => {
    mockApiClient.mockRejectedValue(new Error('refresh failed'));

    const { result } = renderHook(() => useDashboardData(DEMO), { wrapper });

    await waitFor(() => expect(mockApiClient).toHaveBeenCalled());

    expect(result.current.data).toEqual(DEMO);
  });
});
