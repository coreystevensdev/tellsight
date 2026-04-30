import type { APIRequestContext } from '@playwright/test';
import postgres from 'postgres';
import { DATABASE_ADMIN_URL } from './config';

interface AnalyticsEvent {
  id: number;
  eventName: string;
  orgName: string;
  userEmail: string;
  userName: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface DbEvent {
  id: number;
  event_name: string;
  org_id: number;
  user_id: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface QueryOptions {
  eventName?: string;
  since?: string;
  orgId?: number;
  limit?: number;
}

let _sql: ReturnType<typeof postgres> | null = null;

function getAdminSql() {
  if (!_sql) _sql = postgres(DATABASE_ADMIN_URL, { max: 2 });
  return _sql;
}

export async function cleanupAdminConnection(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

/**
 * Queries analytics events via the admin API endpoint.
 * Retries on 429 (rate limited).
 */
export async function queryAnalyticsEvents(
  request: APIRequestContext,
  opts: QueryOptions = {},
): Promise<AnalyticsEvent[]> {
  const params = new URLSearchParams();
  if (opts.eventName) params.set('eventName', opts.eventName);
  if (opts.since) params.set('startDate', opts.since);
  if (opts.orgId) params.set('orgId', String(opts.orgId));
  params.set('limit', String(opts.limit ?? 200));

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.get(`/api/admin/analytics-events?${params}`);
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    if (!res.ok()) {
      throw new Error(`Admin analytics query failed: ${res.status()} ${await res.text()}`);
    }
    const body = await res.json();
    return body.data as AnalyticsEvent[];
  }

  throw new Error('Admin analytics query failed after 3 retries (rate limited)');
}

/**
 * Polls the DB directly for a specific event, bypassing the API rate limiter.
 * Used by E2E tests where fire-and-forget event writes need a short delay.
 */
export async function waitForEvent(
  _request: APIRequestContext,
  eventName: string,
  since: string,
  maxAttempts = 10,
): Promise<DbEvent | null> {
  const sql = getAdminSql();

  // initial delay, fire-and-forget writes need time to persist
  await new Promise((r) => setTimeout(r, 2_000));

  for (let i = 0; i < maxAttempts; i++) {
    const rows = await sql<DbEvent[]>`
      SELECT id, event_name, org_id, user_id, metadata, created_at::text
      FROM analytics_events
      WHERE event_name = ${eventName}
        AND created_at >= ${since}::timestamptz
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  return null;
}
