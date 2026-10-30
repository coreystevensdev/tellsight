import {
  dataRowsQueries,
  datasetsQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
} from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import type { ComputedStat } from '../../services/curation/types.js';
import { buildPriorContext, type PriorContextEntry } from './buildPriorContext.js';
import { composePriorContext } from './composePriorContext.js';
import { detectFirstTimeMilestones, type FirstTimeMilestone } from './firstTimeMilestones.js';
import { detectTransitionMilestones, type TransitionMilestone } from './milestones.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface PrepareDigestContextInput {
  orgId: number;
  datasetId: number;
  weekStart: Date;
  currentStats: ComputedStat[];
  monthlyFixedCosts: number | null | undefined;
  correlationId: string;
}

export interface PreparedDigestContext {
  firstTimeMilestones: FirstTimeMilestone[];
  transitionMilestones: TransitionMilestone[];
  priorContext: string;
  promptVersion: 'v1-digest' | 'v2-digest';
  noNewData: {
    datasetCreatedAt: Date;
    priorDigestWeekStart: Date;
  } | null;
}

export async function prepareDigestContext({
  orgId,
  datasetId,
  weekStart,
  currentStats,
  monthlyFixedCosts,
  correlationId,
}: PrepareDigestContextInput): Promise<PreparedDigestContext> {
  const lastDigest = await digestHistoryQueries.getLastDigest(orgId, weekStart);

  // keyStats is cast, not validated, at the query-helper layer. Invalid prior
  // rows degrade to an empty comparison rather than failing this week's send.
  let deltaEntries: PriorContextEntry[] = [];
  let transitionMilestones: TransitionMilestone[] = [];
  try {
    const priorStats = lastDigest?.keyStats ?? [];
    deltaEntries = buildPriorContext(currentStats, priorStats);
    transitionMilestones = detectTransitionMilestones(currentStats, priorStats);
  } catch (err) {
    logger.error(
      { correlationId, orgId, weekStart, err },
      'Failed to derive prior-digest context, continuing with no prior context',
    );
  }

  // These worker reads use dbAdmin because there is no request-scoped RLS
  // session. Monthly history and the award ledger drive fire-once milestones.
  const monthlyBuckets = await dataRowsQueries.getMonthlyBucketsByDataset(
    orgId,
    datasetId,
    dbAdmin,
  );
  const awardedKinds = await milestoneAwardsQueries.getAwardedKinds(orgId);
  const firstTimeMilestones = detectFirstTimeMilestones(
    monthlyBuckets,
    monthlyFixedCosts,
    new Date(),
    awardedKinds,
  );

  // first_break_even is the all-time version of crossed_break_even. Avoid
  // narrating the same crossing twice when both catalogs fire in one week.
  const firedFirstBreakEven = firstTimeMilestones.some(
    (milestone) => milestone.kind === 'first_break_even',
  );
  const dedupedTransitionMilestones = firedFirstBreakEven
    ? transitionMilestones.filter((milestone) => milestone.kind !== 'crossed_break_even')
    : transitionMilestones;
  const milestones = [...firstTimeMilestones, ...dedupedTransitionMilestones];

  // Datasets are immutable: a dataset no newer than the prior digest means no
  // new upload arrived. Milestones remain an explicit guard because they can
  // depend on the wall clock as well as the underlying financial data.
  const activeDataset = await datasetsQueries.getDatasetById(orgId, datasetId, dbAdmin);
  const priorWeekStart = lastDigest?.weekStart;
  const noNewData =
    priorWeekStart instanceof Date &&
    activeDataset?.createdAt instanceof Date &&
    activeDataset.createdAt.getTime() <= priorWeekStart.getTime() &&
    deltaEntries.length === 0 &&
    milestones.length === 0
      ? {
          datasetCreatedAt: activeDataset.createdAt,
          priorDigestWeekStart: priorWeekStart,
        }
      : null;

  // Skipped weeks make gaps ordinary, so describe the actual distance from
  // the most recent digest instead of always calling it "last week".
  const weeksSincePrior = priorWeekStart
    ? Math.max(1, Math.round((weekStart.getTime() - priorWeekStart.getTime()) / WEEK_MS))
    : 1;
  const priorContext = composePriorContext(
    lastDigest?.stateSentence,
    deltaEntries,
    milestones,
    weeksSincePrior,
  );

  return {
    firstTimeMilestones,
    transitionMilestones: dedupedTransitionMilestones,
    priorContext,
    promptVersion: priorContext.length > 0 ? 'v2-digest' : 'v1-digest',
    noNewData,
  };
}
