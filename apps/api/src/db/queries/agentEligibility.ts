import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions } from '../schema.js';
import { canceledWithGracePeriod } from './subscriptionEligibility.js';

export interface EligibleOrg {
  id: number;
  activeDatasetId: number;
}

type DrizzleClient = typeof dbAdmin;

/**
 * Builds the eligibility query (without executing it). Exposed for SQL-shape
 * tests, same rig as alertEligibility.test.ts: no fixture database, assert
 * the emitted predicates via `.toSQL()`. `asOf` defaults to the current time
 * for direct callers/tests; `findEligibleOrgs` callers should pin one value
 * per sweep instead (see its own doc comment).
 */
export function buildEligibilityQuery(
  client: DrizzleClient,
  cursor?: number,
  pageSize = 500,
  asOf: Date = new Date(),
) {
  const conditions = [
    or(eq(subscriptions.status, 'active'), canceledWithGracePeriod(asOf)),
    eq(subscriptions.plan, 'pro'),
    eq(subscriptions.agentEnabled, true),
    isNotNull(orgs.activeDatasetId),
  ];

  if (cursor !== undefined) conditions.push(lt(orgs.id, cursor));

  return client
    .select({
      id: orgs.id,
      activeDatasetId: orgs.activeDatasetId,
    })
    .from(orgs)
    .innerJoin(subscriptions, eq(subscriptions.orgId, orgs.id))
    .where(and(...conditions))
    .orderBy(desc(orgs.id))
    .limit(pageSize);
}

/**
 * Single-query enumeration of orgs the agent orchestrator cron pages
 * against.
 *
 * Eligibility rules (all of the following must hold):
 *   - subscription.status='active', OR status='canceled' with currentPeriodEnd
 *     still in the future (grace period, same branch getAgentEnabled in
 *     subscriptions.ts checks -- the active branch here stays a bare status
 *     check, unlike getAgentEnabled's, since no ticket has asked for that yet)
 *   - subscription.plan='pro' AND agent_enabled=true
 *   - org has a non-null activeDatasetId
 *
 * Pagination is keyset on orgs.id DESC, same shape as findEligibleOrgs in
 * alertEligibility.ts.
 *
 * `asOf` should be pinned once by the caller and reused across every page of
 * one sweep -- otherwise a canceled org's grace-period eligibility could flip
 * mid-sweep as `now()` advances page to page. Defaults to the current time
 * for callers (e.g. tests) that only ever request a single page.
 *
 * Bypasses RLS via dbAdmin, this is a platform sweep, not a user request.
 */
export async function findEligibleOrgs(
  cursor?: number,
  pageSize = 500,
  asOf: Date = new Date(),
): Promise<EligibleOrg[]> {
  const rows = await buildEligibilityQuery(dbAdmin, cursor, pageSize, asOf);
  return rows.filter((r): r is EligibleOrg => r.activeDatasetId !== null);
}
