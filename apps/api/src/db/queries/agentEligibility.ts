import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions } from '../schema.js';

export interface EligibleOrg {
  id: number;
  activeDatasetId: number;
}

type DrizzleClient = typeof dbAdmin;

/**
 * Builds the eligibility query (without executing it). Exposed for SQL-shape
 * tests, same rig as alertEligibility.test.ts: no fixture database, assert
 * the emitted predicates via `.toSQL()`.
 */
export function buildEligibilityQuery(
  client: DrizzleClient,
  cursor?: number,
  pageSize = 500,
) {
  const conditions = [
    eq(subscriptions.status, 'active'),
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
 * Eligibility rules:
 *   - subscription.status='active' AND subscription.plan='pro' AND agent_enabled=true
 *   - org has a non-null activeDatasetId
 *
 * Pagination is keyset on orgs.id DESC, same shape as findEligibleOrgs in
 * alertEligibility.ts.
 *
 * Bypasses RLS via dbAdmin, this is a platform sweep, not a user request.
 */
export async function findEligibleOrgs(
  cursor?: number,
  pageSize = 500,
): Promise<EligibleOrg[]> {
  const rows = await buildEligibilityQuery(dbAdmin, cursor, pageSize);
  return rows.filter((r): r is EligibleOrg => r.activeDatasetId !== null);
}
