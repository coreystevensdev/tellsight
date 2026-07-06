import { sql } from 'drizzle-orm';
import { dbAdmin } from '../../lib/db.js';
import { ANALYTICS_EVENTS } from 'shared/constants';

export interface WindowCounts {
  unsubscribed: number;
  bounced: number;
  complained: number;
  digestsSent: number;
  // Server-side dedupe via COUNT(DISTINCT (user_id, weekStart)): duplicate
  // pixel hits or click POSTs collapse to one event per {user, week}. Open
  // rate is inflated by Apple Mail Privacy Protection (40-60% of consumer
  // iOS mail), so the panel renders the caveat next to it; CTR is the
  // cleaner engagement signal.
  opened: number;
  clicked: number;
}

export interface EmailComplianceMetrics {
  totalProUsers: number;
  // Denominator for the unsubscribe rate: current count of users whose
  // cadence is something other than 'off'. Fallback when no snapshot table
  // exists. Fine for trend signal; not a perfect window-start figure.
  cadenceActiveUsers: number;
  d7: WindowCounts;
  d30: WindowCounts;
  computedAt: string;
}

// Why rates not counts: the Gmail/Yahoo 2024 deliverability ceiling is 0.3%
// complaint rate; raw counts are uninterpretable without the denominator.
// We return numerators + denominators here and let the panel compute the
// rate at display time so the UI can render "X% (Y of Z)" + null-handle
// zero-denominator windows.
export async function getEmailComplianceMetrics(): Promise<EmailComplianceMetrics> {
  const result = await dbAdmin.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM subscriptions
        WHERE status = 'active' AND tier = 'pro') AS total_pro_users,
      (SELECT COUNT(*)::int FROM digest_preferences
        WHERE cadence <> 'off') AS cadence_active_users,

      (SELECT COUNT(*)::int FROM digest_preferences
        WHERE unsubscribed_at >= NOW() - INTERVAL '7 days') AS unsub_7d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.EMAIL_BOUNCED}
          AND created_at >= NOW() - INTERVAL '7 days') AS bounce_7d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.EMAIL_COMPLAINED}
          AND created_at >= NOW() - INTERVAL '7 days') AS complaint_7d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_SENT}
          AND created_at >= NOW() - INTERVAL '7 days') AS sent_7d,
      (SELECT COUNT(DISTINCT (user_id, metadata->>'weekStart'))::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_OPENED}
          AND created_at >= NOW() - INTERVAL '7 days') AS opened_7d,
      (SELECT COUNT(DISTINCT (user_id, metadata->>'weekStart'))::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_CLICKED}
          AND created_at >= NOW() - INTERVAL '7 days') AS clicked_7d,

      (SELECT COUNT(*)::int FROM digest_preferences
        WHERE unsubscribed_at >= NOW() - INTERVAL '30 days') AS unsub_30d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.EMAIL_BOUNCED}
          AND created_at >= NOW() - INTERVAL '30 days') AS bounce_30d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.EMAIL_COMPLAINED}
          AND created_at >= NOW() - INTERVAL '30 days') AS complaint_30d,
      (SELECT COUNT(*)::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_SENT}
          AND created_at >= NOW() - INTERVAL '30 days') AS sent_30d,
      (SELECT COUNT(DISTINCT (user_id, metadata->>'weekStart'))::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_OPENED}
          AND created_at >= NOW() - INTERVAL '30 days') AS opened_30d,
      (SELECT COUNT(DISTINCT (user_id, metadata->>'weekStart'))::int FROM analytics_events
        WHERE event_name = ${ANALYTICS_EVENTS.DIGEST_CLICKED}
          AND created_at >= NOW() - INTERVAL '30 days') AS clicked_30d
  `);

  const row = (result as unknown as { rows?: Record<string, number | string>[] }).rows?.[0]
    ?? (result as unknown as Record<string, number | string>[])[0]
    ?? {};

  const num = (key: string): number => Number(row[key] ?? 0);

  return {
    totalProUsers: num('total_pro_users'),
    cadenceActiveUsers: num('cadence_active_users'),
    d7: {
      unsubscribed: num('unsub_7d'),
      bounced: num('bounce_7d'),
      complained: num('complaint_7d'),
      digestsSent: num('sent_7d'),
      opened: num('opened_7d'),
      clicked: num('clicked_7d'),
    },
    d30: {
      unsubscribed: num('unsub_30d'),
      bounced: num('bounce_30d'),
      complained: num('complaint_30d'),
      digestsSent: num('sent_30d'),
      opened: num('opened_30d'),
      clicked: num('clicked_30d'),
    },
    computedAt: new Date().toISOString(),
  };
}
