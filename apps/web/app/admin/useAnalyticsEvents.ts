'use client';

import { useState } from 'react';

import { apiClient } from '@/lib/api-client';
import { useResource } from '@/lib/hooks/useResource';
import type { AdminOrgRow, AnalyticsEventRow, AnalyticsEventsMeta } from './types';

const PAGE_SIZE = 50;

export interface AnalyticsEventFilters {
  eventName: string;
  orgId: string;
  datePreset: string;
}

function buildAnalyticsEventParams(page: number, filters: AnalyticsEventFilters) {
  const params = new URLSearchParams();
  if (filters.eventName) params.set('eventName', filters.eventName);
  if (filters.orgId) params.set('orgId', filters.orgId);

  if (filters.datePreset) {
    const days = Number(filters.datePreset);
    const start = new Date();
    if (days === 0) start.setHours(0, 0, 0, 0);
    else start.setDate(start.getDate() - days);
    params.set('startDate', start.toISOString());
    params.set('endDate', new Date().toISOString());
  }

  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String((page - 1) * PAGE_SIZE));
  return params;
}

export function useAnalyticsEvents() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AnalyticsEventFilters>({
    eventName: '',
    orgId: '',
    datePreset: '',
  });

  const requestKey = JSON.stringify({ page, filters });
  const result = useResource(requestKey, async (signal) => {
    const response = await apiClient<AnalyticsEventRow[]>(
      `/admin/analytics-events?${buildAnalyticsEventParams(page, filters)}`,
      { signal },
    );
    return {
      rows: response.data,
      meta: response.meta as unknown as AnalyticsEventsMeta,
    };
  });

  const orgList = useResource('admin-orgs', async (signal) => {
    const response = await apiClient<AdminOrgRow[]>('/admin/orgs', { signal });
    return response.data;
  });

  const events = result.data?.rows ?? [];
  const meta = result.data?.meta ?? null;
  const loading = result.status === 'loading';
  const orgs = orgList.data ?? [];
  const orgsFailed = orgList.status === 'error';
  const totalPages = meta?.pagination?.totalPages ?? 1;

  function changeFilter(key: keyof AnalyticsEventFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  return {
    page,
    filters,
    events,
    meta,
    loading,
    orgs,
    orgsFailed,
    totalPages,
    changeFilter,
    previousPage: () => setPage((current) => Math.max(1, current - 1)),
    nextPage: () => setPage((current) => Math.min(totalPages, current + 1)),
  };
}
