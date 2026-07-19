import type { CitationResponse } from 'shared/types';

import { dataRowsQueries, orgsQueries } from '../../db/queries/index.js';
import { withRlsContext } from '../../lib/rls.js';
import { logger } from '../../lib/logger.js';
import { resolveStatById } from './computation.js';
import { buildStatDetail } from './statDetail.js';
import { scoringConfig } from './scoring.js';
import type { IdentifiedStat } from './types.js';

type FetchedRows = Awaited<ReturnType<typeof dataRowsQueries.getRowsByDataset>>;

// Shared by aiSummary.ts's HTTP routes and resolveCitation below: all three
// recompute the same pipeline and resolve the same IdentifiedStat before
// diverging on what they do with it. Deliberately HTTP-agnostic (no req/res)
// so a same-process, non-HTTP caller can resolve a stat without faking an
// Express Response. Returns the raw row set, so this is the low-level half
// of the pair; resolveCitation is the row-free half, use that unless the
// caller genuinely needs the underlying rows (as the /rows route does).
export async function fetchAndResolveStat(
  orgId: number,
  isAdmin: boolean,
  datasetId: number,
  statId: string,
): Promise<{ rows: FetchedRows; stat: IdentifiedStat } | null> {
  if (!Number.isInteger(datasetId) || datasetId <= 0) return null;

  const [rows, profile] = await Promise.all([
    withRlsContext(orgId, isAdmin, (tx) => dataRowsQueries.getRowsByDataset(orgId, datasetId, tx)),
    orgsQueries.getBusinessProfile(orgId),
  ]);

  const financials = profile
    ? {
        cashOnHand: profile.cashOnHand,
        cashAsOfDate: profile.cashAsOfDate,
        monthlyFixedCosts: profile.monthlyFixedCosts,
      }
    : null;

  const stat = resolveStatById(rows, datasetId, statId, {
    trendMinPoints: scoringConfig.thresholds.trendMinDataPoints,
    financials,
  });

  if (!stat) {
    logger.warn({ orgId, datasetId, statId }, 'stat citation not found on recompute');
    return null;
  }

  return { rows, stat };
}

// Pure citation-render primitive for same-process callers that need to cite
// a stat by id without a Response object or the underlying rows, keeping
// the owner's row-level data out of anything that eventually feeds an LLM.
export async function resolveCitation(
  orgId: number,
  isAdmin: boolean,
  datasetId: number,
  statId: string,
): Promise<CitationResponse | null> {
  const resolution = await fetchAndResolveStat(orgId, isAdmin, datasetId, statId);
  if (!resolution) return null;

  const { stat } = resolution;
  return {
    statId,
    datasetId,
    statType: stat.statType,
    value: stat.value,
    detail: buildStatDetail(stat),
  };
}
