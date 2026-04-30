'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { apiClient } from '@/lib/api-client';
import type { AnalyticsEventRow, AnalyticsEventsMeta, AdminOrgRow } from './types';
import { dateTimeFmt } from './formatters';

const PAGE_SIZE = 50;

const EVENT_OPTIONS = Object.values(ANALYTICS_EVENTS);

const DATE_PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
] as const;

function eventBadge(name: string) {
  const prefix = name.split('.')[0] ?? '';
  const colorMap: Record<string, string> = {
    user: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    org: 'bg-green-500/10 text-green-700 dark:text-green-400',
    dataset: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    ai: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
    share: 'bg-pink-500/10 text-pink-700 dark:text-pink-400',
    subscription: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    dashboard: 'bg-slate-500/10 text-slate-700 dark:text-slate-400',
    chart: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
    ai_preview: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
    transparency_panel: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  };
  const cls = colorMap[prefix] ?? 'bg-muted text-muted-foreground';

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {name}
    </span>
  );
}

function metadataCell(metadata: Record<string, unknown> | null) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <details className="cursor-pointer">
      <summary className="text-xs text-muted-foreground hover:text-foreground">
        {Object.keys(metadata).length} field{Object.keys(metadata).length !== 1 ? 's' : ''}
      </summary>
      <pre className="mt-1 max-w-xs overflow-auto rounded bg-muted p-2 text-xs">
        {JSON.stringify(metadata, null, 2)}
      </pre>
    </details>
  );
}

function SkeletonRows() {
  return Array.from({ length: 5 }, (_, i) => (
    <TableRow key={i}>
      {Array.from({ length: 6 }, (_, j) => (
        <TableCell key={j}>
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

interface Filters {
  eventName: string;
  orgId: string;
  datePreset: string;
}

export function AnalyticsEventsTable() {
  const [events, setEvents] = useState<AnalyticsEventRow[]>([]);
  const [meta, setMeta] = useState<AnalyticsEventsMeta | null>(null);
  const [orgs, setOrgs] = useState<AdminOrgRow[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({ eventName: '', orgId: '', datePreset: '' });

  const fetchEvents = useCallback(async (pg: number, f: Filters) => {
    setLoading(true);
    const params = new URLSearchParams();

    if (f.eventName) params.set('eventName', f.eventName);
    if (f.orgId) params.set('orgId', f.orgId);

    if (f.datePreset) {
      const days = Number(f.datePreset);
      const start = new Date();
      if (days === 0) {
        start.setHours(0, 0, 0, 0);
      } else {
        start.setDate(start.getDate() - days);
      }
      params.set('startDate', start.toISOString());
      params.set('endDate', new Date().toISOString());
    }

    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((pg - 1) * PAGE_SIZE));

    try {
      const res = await apiClient<AnalyticsEventRow[]>(`/admin/analytics-events?${params}`);
      setEvents(res.data);
      setMeta(res.meta as unknown as AnalyticsEventsMeta);
    } catch {
      setEvents([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    apiClient<AdminOrgRow[]>('/admin/orgs')
      .then((res) => setOrgs(res.data))
      .catch(() => setOrgsFailed(true));
  }, []);

  useEffect(() => {
    fetchEvents(page, filters);
  }, [page, filters, fetchEvents]);

  function handleFilterChange(key: keyof Filters, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  const totalPages = meta?.pagination?.totalPages ?? 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        <div className="flex flex-wrap gap-3" role="search" aria-label="Filter analytics events">
          <select
            value={filters.eventName}
            onChange={(e) => handleFilterChange('eventName', e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filter by event type"
          >
            <option value="">All events</option>
            {EVENT_OPTIONS.map((ev) => (
              <option key={ev} value={ev}>{ev}</option>
            ))}
          </select>

          <select
            value={filters.orgId}
            onChange={(e) => handleFilterChange('orgId', e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filter by organization"
            disabled={orgsFailed}
          >
            <option value="">{orgsFailed ? 'Failed to load orgs' : 'All organizations'}</option>
            {orgs.map((org) => (
              <option key={org.id} value={String(org.id)}>{org.name}</option>
            ))}
          </select>

          <select
            value={filters.datePreset}
            onChange={(e) => handleFilterChange('datePreset', e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filter by date range"
          >
            <option value="">All time</option>
            {DATE_PRESETS.map((p) => (
              <option key={p.days} value={String(p.days)}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRows />
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No events found
                </TableCell>
              </TableRow>
            ) : (
              events.map((ev) => (
                <TableRow key={ev.id}>
                  <TableCell>{eventBadge(ev.eventName)}</TableCell>
                  <TableCell className="font-medium">{ev.orgName}</TableCell>
                  <TableCell className="text-muted-foreground">{ev.userEmail}</TableCell>
                  <TableCell className="text-muted-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
                    {dateTimeFmt.format(new Date(ev.createdAt))}
                  </TableCell>
                  <TableCell>{metadataCell(ev.metadata)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {meta ? `${meta.total} event${meta.total !== 1 ? 's' : ''} total` : '\u00A0'}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm" style={{ fontFeatureSettings: '"tnum"' }} aria-label={`Page ${page} of ${totalPages}`}>
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
