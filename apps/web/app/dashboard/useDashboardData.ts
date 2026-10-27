'use client';

import { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import type { ChartData } from 'shared/types';

import { apiClient } from '@/lib/api-client';
import { computeDateRange } from './dateRange';
import {
  EMPTY_FILTERS,
  customRange,
  filtersFromQuery,
  filtersToQuery,
  type FilterState,
} from './filterParams';

function buildSwrKey(filters: FilterState): string {
  const params = new URLSearchParams();
  // A complete custom range wins; an incomplete range falls back to its preset.
  const range =
    customRange(filters) ?? (filters.datePreset ? computeDateRange(filters.datePreset) : null);
  if (range) {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  if (filters.category) params.set('categories', filters.category);
  if (filters.granularity && filters.granularity !== 'monthly') {
    params.set('granularity', filters.granularity);
  }
  const query = params.toString();
  return query ? `/dashboard/charts?${query}` : '/dashboard/charts';
}

async function fetchChartData(key: string): Promise<ChartData> {
  const response = await apiClient<ChartData>(key.startsWith('/') ? key : `/${key}`);
  return response.data;
}

export function useDashboardData(initialData: ChartData) {
  const searchParams = useSearchParams();
  // URL changes use replaceState below, so the URL is only an input on mount.
  // A hand-edited URL performs a real navigation and mounts a new shell.
  const [filters, setFilters] = useState<FilterState>(() => filtersFromQuery(searchParams));
  const {
    data = initialData,
    isLoading,
    mutate,
  } = useSWR(buildSwrKey(filters), fetchChartData, {
    fallbackData: initialData,
    revalidateOnFocus: true,
    revalidateOnReconnect: false,
    keepPreviousData: true,
  });

  // This route owns its client-side filters. Avoiding a router navigation keeps
  // the server component from refetching data already managed by SWR.
  const applyFilters = useCallback((next: FilterState) => {
    setFilters(next);
    const query = filtersToQuery(next);
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, []);

  const resetFilters = useCallback(() => applyFilters(EMPTY_FILTERS), [applyFilters]);
  const hasData = data.revenueTrend.length > 0 || data.expenseBreakdown.length > 0;

  return {
    data,
    isLoading,
    mutate,
    filters,
    applyFilters,
    resetFilters,
    hasData,
    hasAnyData: initialData.revenueTrend.length > 0 || initialData.expenseBreakdown.length > 0,
    hasActiveFilters:
      filters.datePreset !== null || filters.category !== null || filters.granularity !== 'monthly',
  };
}
