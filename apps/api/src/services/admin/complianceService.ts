import { sql } from 'drizzle-orm';
import { dbAdmin } from '../../lib/db.js';
import { ANALYTICS_EVENTS } from 'shared/constants';
import type { AlertRuleKind } from 'shared/schemas';

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
        WHERE status = 'active' AND plan = 'pro') AS total_pro_users,
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

export interface AlertFireWindowCounts {
  fired: number;
  quotaSuppressed: number;
}

export interface AlertRuleKindEffectiveness {
  ruleKind: AlertRuleKind;
  totalRules: number;
  fired: number;
  clicked: number;
  // Count of rules (not fires) with at least one fire whose 7-day click
  // window has fully elapsed and zero matching clicks across any of its
  // fires, see complianceService's getAlertComplianceMetrics query. Read-only
  // signal for manual operator review, never auto-disabled.
  candidateDefaultOffRules: number;
}

export interface AlertComplianceMetrics {
  totalRules: number;
  mutedRules: number;
  d7: AlertFireWindowCounts;
  d30: AlertFireWindowCounts;
  byRuleKind: AlertRuleKindEffectiveness[];
  computedAt: string;
}

export async function getAlertComplianceMetrics(): Promise<AlertComplianceMetrics> {
  const [summaryResult, byKindResult] = await Promise.all([
    dbAdmin.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM alert_rules WHERE deleted_at IS NULL) AS total_rules,
        (SELECT COUNT(*)::int FROM alert_rules
          WHERE deleted_at IS NULL AND mute_until > NOW()) AS muted_rules,
        (SELECT COUNT(*)::int FROM analytics_events
          WHERE event_name = ${ANALYTICS_EVENTS.ALERT_FIRED}
            AND created_at >= NOW() - INTERVAL '7 days') AS fired_7d,
        (SELECT COUNT(*)::int FROM analytics_events
          WHERE event_name = ${ANALYTICS_EVENTS.ALERT_QUOTA_SUPPRESSED}
            AND created_at >= NOW() - INTERVAL '7 days') AS quota_suppressed_7d,
        (SELECT COUNT(*)::int FROM analytics_events
          WHERE event_name = ${ANALYTICS_EVENTS.ALERT_FIRED}
            AND created_at >= NOW() - INTERVAL '30 days') AS fired_30d,
        (SELECT COUNT(*)::int FROM analytics_events
          WHERE event_name = ${ANALYTICS_EVENTS.ALERT_QUOTA_SUPPRESSED}
            AND created_at >= NOW() - INTERVAL '30 days') AS quota_suppressed_30d
    `),
    // rule_stats aggregates per rule first (fire count, click count, whether
    // any fire cleared the 7-day click window) so candidate-default-off can
    // count rules, not fires; the outer query rolls that up by kind and
    // cross-joins the enum so a kind with zero rules still renders a 0 row
    // instead of vanishing from the table. Fires windowed to 30 days, same
    // as every other metric in this file, so the join doesn't scan the
    // rule's entire lifetime history on every admin page load.
    //
    // COUNT(DISTINCT f.id): a fire with more than one matching click (opened
    // on two devices, forwarded) fans the join out to multiple rows per
    // fire, a plain COUNT(f.id) would double-count that fire. click_count
    // uses the same DISTINCT-fire unit (fires with >=1 click, not raw click
    // rows) so click_count can never exceed fire_count and the panel's click
    // rate stays a real percentage instead of reading e.g. "300%" for a fire
    // opened on multiple devices.
    dbAdmin.execute(sql`
      WITH kinds AS (
        SELECT unnest(enum_range(NULL::alert_rule_kind)) AS rule_kind
      ),
      rule_stats AS (
        SELECT
          r.id AS rule_id,
          r.kind AS rule_kind,
          COUNT(DISTINCT f.id) AS fire_count,
          COUNT(DISTINCT f.id) FILTER (WHERE c.id IS NOT NULL) AS click_count,
          BOOL_OR(f.fired_at <= NOW() - INTERVAL '7 days') AS has_elapsed_fire
        FROM alert_rules r
        LEFT JOIN alert_rule_fires f
          ON f.rule_id = r.id AND f.fired_at >= NOW() - INTERVAL '30 days'
        LEFT JOIN analytics_events c
          ON c.event_name = ${ANALYTICS_EVENTS.ALERT_CLICKED}
          AND (c.metadata->>'fireId')::int = f.id
        WHERE r.deleted_at IS NULL
        GROUP BY r.id, r.kind
      )
      SELECT
        kinds.rule_kind::text AS rule_kind,
        COUNT(rule_stats.rule_id)::int AS total_rules,
        COALESCE(SUM(rule_stats.fire_count), 0)::int AS fired,
        COALESCE(SUM(rule_stats.click_count), 0)::int AS clicked,
        COUNT(*) FILTER (
          WHERE rule_stats.has_elapsed_fire AND rule_stats.click_count = 0
        )::int AS candidate_default_off_rules
      FROM kinds
      LEFT JOIN rule_stats ON rule_stats.rule_kind = kinds.rule_kind
      GROUP BY kinds.rule_kind
      ORDER BY kinds.rule_kind
    `),
  ]);

  const summaryRows = (summaryResult as unknown as { rows?: Record<string, number | string>[] }).rows
    ?? (summaryResult as unknown as Record<string, number | string>[]);
  const summary = summaryRows[0] ?? {};
  const num = (key: string): number => Number(summary[key] ?? 0);

  const kindRows = (byKindResult as unknown as { rows?: Record<string, number | string>[] }).rows
    ?? (byKindResult as unknown as Record<string, number | string>[]);

  return {
    totalRules: num('total_rules'),
    mutedRules: num('muted_rules'),
    d7: { fired: num('fired_7d'), quotaSuppressed: num('quota_suppressed_7d') },
    d30: { fired: num('fired_30d'), quotaSuppressed: num('quota_suppressed_30d') },
    byRuleKind: kindRows.map((row) => ({
      ruleKind: row.rule_kind as AlertRuleKind,
      totalRules: Number(row.total_rules ?? 0),
      fired: Number(row.fired ?? 0),
      clicked: Number(row.clicked ?? 0),
      candidateDefaultOffRules: Number(row.candidate_default_off_rules ?? 0),
    })),
    computedAt: new Date().toISOString(),
  };
}
