import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { statCorrectionsQueries, aiSummariesQueries, dataRowsQueries } from '../../../db/queries/index.js';
import { computeStats, assignIds } from '../../../services/curation/computation.js';
import { StatType } from '../../../services/curation/types.js';
import type { ApprovedCorrection } from '../../../db/queries/statCorrections.js';

// No job payload to validate, this fires on a schedule with no per-run input.
export async function handleExpireJob(_job: Job): Promise<void> {
  const expired = await statCorrectionsQueries.expireCorrections(new Date(), dbAdmin);

  // Symmetric to admin.ts's approval-side invalidation: a correction that
  // just expired changes what the next runFullPipeline call excludes, and
  // ai_summaries is cache-first, so without this the stat stays hidden on
  // the dashboard until the org's next CSV upload (see admin.ts for why
  // this only affects the dashboard-audience cache, not digest's, which is
  // pinned to weekStart by design). expireCorrections already committed the
  // status flip, so a retry after a markStale failure here would re-query
  // for status='approved' and silently miss these now-'expired' rows -- each
  // call is wrapped so one failure can't crash the job and trigger that.
  const orgDatasetPairs = new Map(expired.map((c) => [`${c.orgId}:${c.datasetId}`, c]));
  for (const { orgId, datasetId } of orgDatasetPairs.values()) {
    try {
      await aiSummariesQueries.markStale(orgId, dbAdmin, datasetId);
    } catch (err) {
      logger.error(
        { err, orgId, datasetId },
        'Failed to invalidate ai_summaries cache after stat correction expiry; stat stays suppressed until next CSV upload',
      );
    }
  }

  logger.info(
    { expiredCount: expired.length, expiredIds: expired.map((c) => c.id) },
    'Stat correction expiry sweep complete',
  );

  await revalidateAnomalyCorrections();
}

// DW-64: an Anomaly stat's id embeds its computed value (statDiscriminator in
// computation.ts), so a QuickBooks-synced org's dataset, which keeps the same
// datasetId across every sync, can drift an approved correction's id out from
// under it the moment new transactions shift the anomaly's value. Once that
// happens the row stays 'approved' forever but matches nothing in
// scoreInsights. No cache invalidation here (unlike expiry above): orphaning
// doesn't change what scoreInsights excludes, the id already wasn't matching
// anything before this ran.
async function revalidateAnomalyCorrections(): Promise<void> {
  const approved = await statCorrectionsQueries.getApprovedCorrections(dbAdmin);
  const anomalyCorrections = approved.filter((c) => c.statInstanceId.split(':')[1] === StatType.Anomaly);
  if (anomalyCorrections.length === 0) {
    logger.info({ orphanedCount: 0 }, 'Stat correction anomaly re-validation sweep complete');
    return;
  }

  const byDataset = new Map<string, ApprovedCorrection[]>();
  for (const correction of anomalyCorrections) {
    const key = `${correction.orgId}:${correction.datasetId}`;
    const group = byDataset.get(key);
    if (group) group.push(correction);
    else byDataset.set(key, [correction]);
  }

  // Each group's recompute is independent (a different org/dataset), so one
  // group's failure (bad row data, a transient DB error) shouldn't sink every
  // other org's re-validation for the day, same reasoning as the markStale
  // loop above wrapping each call individually.
  const orphanedCandidateIds: number[] = [];
  for (const group of byDataset.values()) {
    const { orgId, datasetId } = group[0]!;
    try {
      const rows = await dataRowsQueries.getRowsByDataset(orgId, datasetId, dbAdmin);
      const currentIds = new Set(assignIds(computeStats(rows), datasetId).map((s) => s.id));
      for (const correction of group) {
        if (!currentIds.has(correction.statInstanceId)) orphanedCandidateIds.push(correction.id);
      }
    } catch (err) {
      logger.error(
        { err, orgId, datasetId },
        'Failed to recompute stats for anomaly correction re-validation; corrections for this dataset stay approved until the next sweep',
      );
    }
  }
  if (orphanedCandidateIds.length === 0) {
    logger.info({ orphanedCount: 0 }, 'Stat correction anomaly re-validation sweep complete');
    return;
  }

  const orphanedIds = await statCorrectionsQueries.orphanCorrections(orphanedCandidateIds, dbAdmin);
  logger.info(
    { orphanedCount: orphanedIds.length, orphanedIds },
    'Stat correction anomaly re-validation sweep complete',
  );
}
