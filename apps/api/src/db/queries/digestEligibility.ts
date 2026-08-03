import { sql, and, eq, lt, isNotNull, gte, exists, or, isNull, ne, desc } from 'drizzle-orm';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions, datasets, userOrgs, digestPreferences, users } from '../schema.js';
import { canceledWithGracePeriod } from './subscriptionEligibility.js';

export interface EligibleOrg {
  id: number;
  name: string;
  activeDatasetId: number;
  businessProfile: unknown;
}

const RECENT_DATASET_INTERVAL = sql`now() - interval '30 days'`;

type DrizzleClient = typeof dbAdmin;

/**
 * Builds the eligibility query (without executing it). Exposed so tests can
 * inspect the emitted SQL via `.toSQL()` and assert the predicates without
 * needing a real database. Use `findEligibleOrgs` for the executable form.
 * `asOf` defaults to the current time for direct callers/tests;
 * `findEligibleOrgs` callers should pin one value per sweep instead (see its
 * own doc comment).
 */
export function buildEligibilityQuery(
  client: DrizzleClient,
  cursor?: number,
  pageSize = 500,
  asOf: Date = new Date(),
) {
  const memberOptedIn = exists(
    client
      .select({ x: sql`1` })
      .from(userOrgs)
      .leftJoin(digestPreferences, eq(digestPreferences.userId, userOrgs.userId))
      .where(
        and(
          eq(userOrgs.orgId, orgs.id),
          or(isNull(digestPreferences.cadence), ne(digestPreferences.cadence, 'off')),
        ),
      ),
  );

  const conditions = [
    or(eq(subscriptions.status, 'active'), canceledWithGracePeriod(asOf)),
    eq(subscriptions.plan, 'pro'),
    isNotNull(orgs.activeDatasetId),
    gte(datasets.createdAt, RECENT_DATASET_INTERVAL),
    memberOptedIn,
  ];

  if (cursor !== undefined) conditions.push(lt(orgs.id, cursor));

  return client
    .select({
      id: orgs.id,
      name: orgs.name,
      activeDatasetId: orgs.activeDatasetId,
      businessProfile: orgs.businessProfile,
    })
    .from(orgs)
    .innerJoin(subscriptions, eq(subscriptions.orgId, orgs.id))
    .innerJoin(datasets, eq(datasets.id, orgs.activeDatasetId))
    .where(and(...conditions))
    .orderBy(desc(orgs.id))
    .limit(pageSize);
}

/**
 * Single-query enumeration of orgs that should receive a weekly digest.
 *
 * Eligibility rules:
 *   - subscription.status='active', OR status='canceled' with currentPeriodEnd
 *     still in the future (grace period, same canceled-branch condition
 *     getAgentEnabled in subscriptions.ts checks -- the active branch here
 *     stays a bare status check, unlike getAgentEnabled's, since no ticket
 *     has asked for that nuance here yet)
 *   - subscription.plan='pro'
 *   - org has an activeDataset that was created within the last 30 days
 *   - at least one org member has digest_preferences.cadence != 'off' (NULL
 *     defaults to 'weekly', so a user with no row counts as opted-in)
 *
 * Pagination is keyset on orgs.id DESC. Pass `cursor=undefined` for the first
 * page; pass the smallest id from the previous page as `cursor` for the next.
 *
 * `asOf` should be pinned once by the caller and reused across every page of
 * one sweep -- otherwise a canceled org's grace-period eligibility could flip
 * mid-sweep as `now()` advances page to page. Defaults to the current time
 * for callers (e.g. tests) that only ever request a single page.
 *
 * Bypasses RLS via dbAdmin, this is a platform operation, not a user request.
 */
export async function findEligibleOrgs(
  cursor?: number,
  pageSize = 500,
  asOf: Date = new Date(),
): Promise<EligibleOrg[]> {
  const rows = await buildEligibilityQuery(dbAdmin, cursor, pageSize, asOf);
  // activeDatasetId is non-null per the WHERE clause; narrow the type.
  return rows.filter((r): r is EligibleOrg => r.activeDatasetId !== null);
}

export interface DigestRecipient {
  userId: number;
  email: string;
  name: string;
}

const SIX_DAYS_AGO = sql`now() - interval '6 days'`;

/**
 * Returns the org members eligible for a per-send job this tick:
 *   - cadence='weekly' (or NULL, which defaults to weekly per table DEFAULT)
 *   - last_sent_at IS NULL OR last_sent_at < now() - interval '6 days'
 *
 * Monthly-cadence users are skipped (weekly-only launch scope). Off-cadence
 * users skip via the cadence filter. Per-user dedupe
 * via the last_sent_at filter prevents a multi-org user from receiving N
 * digests per week.
 *
 * Bypasses RLS via dbAdmin, platform fan-out, not a user request.
 */
export async function findOrgRecipients(orgId: number): Promise<DigestRecipient[]> {
  const rows = await dbAdmin
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(userOrgs)
    .innerJoin(users, eq(users.id, userOrgs.userId))
    .leftJoin(digestPreferences, eq(digestPreferences.userId, userOrgs.userId))
    .where(
      and(
        eq(userOrgs.orgId, orgId),
        or(isNull(digestPreferences.cadence), eq(digestPreferences.cadence, 'weekly')),
        or(isNull(digestPreferences.lastSentAt), lt(digestPreferences.lastSentAt, SIX_DAYS_AGO)),
      ),
    );

  return rows;
}
