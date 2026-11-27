import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../lib/db.js';
import { analyticsEvents, orgs } from './schema.js';
import { getMonthlyAiUsageCount } from './queries/analyticsEvents.js';

// The route records ai.summary_completed on a cache hit as well as on a real
// generation, and the quota count read every such row. On free, quota 3, that
// is one generated summary and two views before a genuine new-data summary is
// refused for the rest of the month. The gate running after the cache check
// stops a cached read being refused and does nothing about this half.
//
// Real Postgres, because the fix is a jsonb predicate. A mocked client returns
// whatever it was told to and would agree with the query either way.

let orgId: number;
const SLUG = 'ai-quota-cache-hit-probe';

// Inside the current month, since getMonthlyAiUsageCount counts from the first
// of it. The org is its own, so nothing else can add to the total.
function thisMonth(dayOffset = 0) {
  const d = new Date();
  d.setDate(2 + dayOffset);
  d.setHours(12, 0, 0, 0);
  return d;
}

async function seed(metadata: Record<string, unknown> | null, at: Date) {
  await dbAdmin.insert(analyticsEvents).values({
    orgId,
    eventName: 'ai.summary_completed',
    metadata,
    createdAt: at,
  });
}

beforeAll(async () => {
  await dbAdmin.delete(orgs).where(eq(orgs.slug, SLUG));
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'ai quota cache hit probe', slug: SLUG })
    .returning({ id: orgs.id });
  orgId = org!.id;
});

afterAll(async () => {
  await dbAdmin.delete(orgs).where(eq(orgs.slug, SLUG));
});

describe('getMonthlyAiUsageCount', () => {
  it('counts a generation and not the cache hits that follow it', async () => {
    await seed({ datasetId: 1, tier: 'free', cacheHit: false }, thisMonth(0));
    await seed({ datasetId: 1, tier: 'free', cacheHit: true }, thisMonth(1));
    await seed({ datasetId: 1, tier: 'free', cacheHit: true }, thisMonth(2));

    // Three rows, one generation. Counting all three is what locked a free org
    // out after reading its own summary twice.
    expect(await getMonthlyAiUsageCount(orgId, dbAdmin)).toBe(1);
  });

  // Rows written before the route tagged cacheHit carry no such key, and
  // ->>'cacheHit' is NULL for them. They are generations and still count, which
  // is why the predicate is IS DISTINCT FROM rather than <>, since NULL <>
  // 'true' is NULL and would drop every one of them.
  it('still counts rows that predate the cacheHit tag', async () => {
    await seed({ datasetId: 2, tier: 'pro' }, thisMonth(3));
    await seed(null, thisMonth(4));

    expect(await getMonthlyAiUsageCount(orgId, dbAdmin)).toBe(3);
  });
});
