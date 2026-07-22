import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { statCorrectionsQueries, aiSummariesQueries } from '../../../db/queries/index.js';

// No job payload to validate, this fires on a schedule with no per-run input.
export async function handleExpireJob(_job: Job): Promise<void> {
  const expired = await statCorrectionsQueries.expireCorrections(new Date(), dbAdmin);

  // Symmetric to admin.ts's approval-side invalidation: a correction that
  // just expired changes what the next runFullPipeline call excludes, and
  // ai_summaries is cache-first, so without this the stat stays hidden
  // until the org's next CSV upload. expireCorrections already committed the
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
}
