import { datasetsQueries, orgsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

/**
 * Points the org's dashboard at a connector's dataset, but only when it is the
 * org's first real source.
 *
 * Every connector used to do this unconditionally on an `initial` sync, which
 * encodes "most recently connected wins". That rule has two problems and DW-296
 * records both.
 *
 * It downgrades a working org silently. Connecting a bank feed alongside
 * QuickBooks moved the dashboard to the feed, and a feed carries transactions
 * without accounting structure, so margin, break-even and concentration stop
 * computing and `cash_flow` is now suppressed outright for a revenue-blind
 * source. Nothing errors. The owner just has fewer insights.
 *
 * And it is the harm nobody notices. An owner migrating from QuickBooks to Xero
 * *wants* the switch, is watching for it, and is one click from it at Settings →
 * Datasets → Set active. An owner who did not want it is not watching, which is
 * how a hand-enqueued backfill repointed org 2 on 2026-11-19 and sat unnoticed
 * for two days. A missing change is visible and cheap to fix; a surprise change
 * is neither.
 *
 * Seed data does not count as a real source, which is the whole point: an org
 * whose first connector lands while the seeded sample is active must claim the
 * dashboard, or the digest keeps reporting on a fictional cafe.
 */
export async function claimDashboardForFirstRealSource(
  orgId: number,
  datasetId: number,
): Promise<boolean> {
  const previousDatasetId = await orgsQueries.getActiveDatasetId(orgId, dbAdmin);

  // A null pointer is its own emergency and outranks the rule below. The
  // dashboard falls back to `datasets[0]` and looks healthy, but the digest,
  // alerts and agent eligibility queries all require a non-null pointer and
  // none of them falls back, so the org goes silent on every one of them. The
  // Square connector already special-cased this with `|| !org?.activeDatasetId`
  // and the helper keeps it rather than dropping it on the way to being shared.
  if (previousDatasetId == null) {
    await orgsQueries.setActiveDataset(orgId, datasetId, dbAdmin);
    logger.info({ orgId, datasetId }, 'Org had no active dataset, this one claimed it');
    return true;
  }

  const existing = await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin);
  const otherRealSources = existing.filter((d) => d.id !== datasetId && !d.isSeedData);

  if (otherRealSources.length > 0) {
    logger.info(
      { orgId, datasetId, otherRealSources: otherRealSources.length },
      'Org already has a real dataset, leaving the dashboard where the owner put it',
    );
    return false;
  }

  await orgsQueries.setActiveDataset(orgId, datasetId, dbAdmin);
  // Logged because the manual route logs its equivalent and this path did not,
  // which is why tracing a repointed dashboard took twenty minutes rather than
  // one grep.
  logger.info(
    { orgId, datasetId, previousDatasetId },
    'First real source claimed the dashboard',
  );
  return true;
}
