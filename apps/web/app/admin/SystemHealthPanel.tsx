'use client';

import useSWR from 'swr';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SystemHealth, ServiceStatus } from './types';

const SERVICE_LABELS: Record<string, string> = {
  database: 'Database',
  redis: 'Redis',
  claude: 'Claude API',
};

const STATUS_COLORS: Record<ServiceStatus['status'], string> = {
  ok: 'bg-success',
  degraded: 'bg-warning',
  error: 'bg-destructive',
};

const STATUS_LABELS: Record<ServiceStatus['status'], string> = {
  ok: 'Healthy',
  degraded: 'Degraded',
  error: 'Unavailable',
};

async function fetcher(url: string) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Health fetch failed: ${res.status}`);
  const json = await res.json();
  return json.data as SystemHealth;
}

function StatusDot({ status }: { status: ServiceStatus['status'] }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[status]}`}
      aria-hidden="true"
    />
  );
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <TableRow key={i}>
          <TableCell><div className="h-4 w-20 animate-pulse rounded bg-muted" /></TableCell>
          <TableCell><div className="h-4 w-16 animate-pulse rounded bg-muted" /></TableCell>
          <TableCell className="text-right"><div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function SystemHealthPanel() {
  const { data, error, isLoading } = useSWR('/api/admin/health', fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });

  const hasData = !!data;
  const showWarning = error && hasData;

  return (
    <Card role="status" aria-live="polite" aria-label="System health status">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">System Health</CardTitle>
        {hasData && (
          <span
            className="text-xs text-muted-foreground"
            style={{ fontFeatureSettings: '"tnum"' }}
          >
            Uptime: {data.uptime.formatted}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {showWarning && (
          <p className="mb-3 text-xs text-yellow-600">
            Unable to refresh — showing last known status
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !hasData ? (
              <SkeletonRows />
            ) : hasData ? (
              Object.entries(data.services).map(([key, svc]) => (
                <TableRow key={key}>
                  <TableCell className="font-medium">
                    {SERVICE_LABELS[key] ?? key}
                  </TableCell>
                  <TableCell>
                    <span
                      className="inline-flex items-center gap-2"
                      aria-label={`${SERVICE_LABELS[key] ?? key}: ${STATUS_LABELS[svc.status]}`}
                    >
                      <StatusDot status={svc.status} />
                      <span className="text-sm">{STATUS_LABELS[svc.status]}</span>
                    </span>
                  </TableCell>
                  <TableCell
                    className="text-right text-muted-foreground"
                    style={{ fontFeatureSettings: '"tnum"' }}
                  >
                    {svc.latencyMs}ms
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                  Unable to load health data
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
