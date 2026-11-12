import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../lib/db.js';
import { alertRuleFires, alertRules, analyticsEvents, orgs } from './schema.js';
import { getAiUsageStats } from './queries/analyticsEvents.js';
import { getAlertComplianceMetrics } from '../services/admin/complianceMetrics.js';

// POST /api/analytics/events allowlists event_name and then, as its own comment
// concedes, stores "whatever the caller sends" as metadata. Both event names
// below are in that single flat allowlist, so any authenticated user can write
// the rows seeded here.
//
// Two admin aggregates then cast those caller-written jsonb fields to int. One
// bad row raises 22P02 for every later call, and the row persists, so the panel
// stays broken until someone deletes it by hand. Mocked unit tests cannot see
// this: the cast only fails inside Postgres.

let orgId: number;
let ruleId: number;
const eventIds: number[] = [];
const WINDOW_START = new Date('2020-01-01T00:00:00Z');
// A later window so the bulk rows below cannot disturb the exact-sum assertion.
const BULK_WINDOW_START = new Date('2020-12-01T00:00:00Z');
const BULK_AT = new Date('2021-01-01T00:00:00Z');
// 10M each, which is the per-row ceiling, so the total clears int4's 2147483647
// without any single row being out of bounds.
const BULK_ROWS = 220;

async function seedEvent(eventName: string, metadata: Record<string, unknown>) {
  const [row] = await dbAdmin
    .insert(analyticsEvents)
    .values({ orgId, eventName, metadata, createdAt: new Date('2020-06-01T00:00:00Z') })
    .returning({ id: analyticsEvents.id });
  eventIds.push(row!.id);
  return row!.id;
}

const SLUG = 'metadata-cast-probe';

beforeAll(async () => {
  // slug is unique, so a run that died before afterAll would block the next one.
  await dbAdmin.delete(orgs).where(eq(orgs.slug, SLUG));

  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'metadata cast probe', slug: SLUG })
    .returning({ id: orgs.id });
  orgId = org!.id;

  // What an attacker writes.
  await seedEvent('ai.summary_completed', { inputTokens: 'not-a-number', outputTokens: 'x' });
  await seedEvent('ai.summary_completed', { inputTokens: null, outputTokens: {} });
  await seedEvent('ai.summary_completed', { inputTokens: '12', outputTokens: [] });
  // A valid JSON number, so jsonb_typeof lets it through. The outer ::int then
  // raised 22003 instead of 22P02: same persistent DoS, different value.
  await seedEvent('ai.summary_completed', { inputTokens: 99999999999, outputTokens: 99999999999 });
  await seedEvent('alert.clicked', { fireId: 'not-a-number' });
  await seedEvent('alert.clicked', { fireId: '' });

  // What the server writes, so the aggregate still has to be right.
  await seedEvent('ai.summary_completed', { inputTokens: 1000, outputTokens: 250 });
  await seedEvent('ai.summary_completed', { inputTokens: 500, outputTokens: 125 });

  // The compliance query LEFT JOINs analytics_events onto alert_rule_fires, so
  // with an empty fires table the cast is never evaluated and a poisoned row
  // looks harmless. One fire inside the 30-day window is what makes the join
  // reach the cast, which is also why production is exposed and an empty local
  // database is not.
  const [rule] = await dbAdmin
    .insert(alertRules)
    .values({ orgId, kind: 'runway_runs_short', threshold: { months: 3 } })
    .returning({ id: alertRules.id });
  ruleId = rule!.id;

  await dbAdmin.insert(alertRuleFires).values({
    orgId,
    ruleId,
    ruleKind: 'runway_runs_short',
    trigger: 'runway below 3 months',
    thresholdValue: { months: 3 },
    currentValue: 2.1,
    band: 1,
    firedAt: new Date(),
  });
});

afterAll(async () => {
  // alert_rule_fires cascades from alert_rules, which cascades from orgs.
  if (ruleId) await dbAdmin.delete(alertRules).where(inArray(alertRules.id, [ruleId]));
  if (eventIds.length) {
    await dbAdmin.delete(analyticsEvents).where(inArray(analyticsEvents.id, eventIds));
  }
  if (orgId) await dbAdmin.delete(orgs).where(inArray(orgs.id, [orgId]));
});

describe('admin aggregates over caller-written analytics metadata', () => {
  // The per-row ceiling and the numeric return guard different things, and with
  // the ceiling in place no single row can overflow int4. This is what makes the
  // numeric return independently visible: enough in-bounds rows to clear the
  // int4 limit in aggregate, which ::int could not have returned.
  it('sums past the int4 ceiling without overflowing', async () => {
    const rows = Array.from({ length: BULK_ROWS }, () => ({
      orgId,
      eventName: 'ai.summary_completed',
      metadata: { inputTokens: 10_000_000, outputTokens: 10_000_000 },
      createdAt: BULK_AT,
    }));
    const inserted = await dbAdmin
      .insert(analyticsEvents)
      .values(rows)
      .returning({ id: analyticsEvents.id });
    const bulkIds = inserted.map((r) => r.id);

    // Removed inside the test rather than in afterAll: getAiUsageStats takes
    // only a window start, so rows this far forward land in every other test's
    // window too and would wreck the exact-sum assertion.
    try {
      const stats = await getAiUsageStats(BULK_WINDOW_START);

      expect(stats.inputTokens).toBe(BULK_ROWS * 10_000_000);
      expect(stats.inputTokens).toBeGreaterThan(2_147_483_647);
    } finally {
      await dbAdmin.delete(analyticsEvents).where(inArray(analyticsEvents.id, bulkIds));
    }
  });

  it('getAiUsageStats survives non-numeric inputTokens', async () => {
    await expect(getAiUsageStats(WINDOW_START)).resolves.toBeDefined();
  });

  // Ignoring the garbage is the point, not merely not crashing: a guard that
  // coerced 'not-a-number' to 0 would pass the test above and still be wrong if
  // it also swallowed the real rows.
  it('sums only the rows that actually carry numbers', async () => {
    const stats = await getAiUsageStats(WINDOW_START);

    expect(stats.inputTokens).toBe(1500);
    expect(stats.outputTokens).toBe(375);
    // Every seeded ai.summary_completed row still counts as a request.
    expect(stats.requestCount).toBeGreaterThanOrEqual(5);
    // Not a string: the column comes back as numeric now, so the mapping has to
    // coerce or every consumer gets '1500' and arithmetic silently concatenates.
    expect(typeof stats.inputTokens).toBe('number');
  });

  it('getAlertComplianceMetrics survives a non-numeric fireId', async () => {
    const metrics = await getAlertComplianceMetrics();

    expect(metrics.byRuleKind.length).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.totalRules)).toBe(true);
  });
});
