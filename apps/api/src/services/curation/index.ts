import type { BusinessProfile, OrgFinancials } from 'shared/types';

import { logger } from '../../lib/logger.js';
import { dataRowsQueries, aiSummariesQueries } from '../../db/queries/index.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { computeStats } from './computation.js';
import { scoreInsights, scoringConfig } from './scoring.js';
import { assemblePrompt } from './assembly.js';
import { validateSummary, validateStatRefs, stripInvalidStatRefs } from './validator.js';
import { generateInterpretation } from '../aiInterpretation/claudeClient.js';
import { transparencyMetadataSchema } from './types.js';
import type { ScoredInsight } from './types.js';

export async function runCurationPipeline(
  orgId: number,
  datasetId: number,
  client?: typeof db | DbTransaction,
  financials?: OrgFinancials | null,
): Promise<ScoredInsight[]> {
  const rows = await dataRowsQueries.getRowsByDataset(orgId, datasetId, client);

  if (rows.length === 0) {
    logger.warn({ orgId, datasetId }, 'curation pipeline got 0 rows — dataset may not exist');
    return [];
  }

  logger.info({ orgId, datasetId, rowCount: rows.length }, 'curation pipeline started');

  const stats = computeStats(rows, {
    trendMinPoints: scoringConfig.thresholds.trendMinDataPoints,
    financials: financials ?? null,
  });
  logger.info({ orgId, statCount: stats.length }, 'curation layer 1 complete');

  const insights = scoreInsights(stats);
  logger.info({ orgId, insightCount: insights.length }, 'curation layer 2 complete');

  return insights;
}

export interface FullPipelineResult {
  content: string;
  fromCache: boolean;
}

export async function runFullPipeline(
  orgId: number,
  datasetId: number,
  businessProfile?: BusinessProfile | null,
): Promise<FullPipelineResult> {
  const cached = await aiSummariesQueries.getCachedSummary(orgId, datasetId);
  if (cached) {
    logger.info({ orgId, datasetId }, 'ai_summaries cache hit');
    return { content: cached.content, fromCache: true };
  }

  logger.warn({ orgId, datasetId }, 'ai_summaries cache miss — generating fresh summary');

  // Pull the financial subset directly from the business profile JSONB — the runway
  // fields (cashOnHand, cashAsOfDate, businessStartedDate, monthlyFixedCosts) live
  // alongside onboarding fields. Pass only the financial subset into the pipeline.
  const financials = businessProfile
    ? {
        cashOnHand: businessProfile.cashOnHand,
        cashAsOfDate: businessProfile.cashAsOfDate,
        businessStartedDate: businessProfile.businessStartedDate,
        monthlyFixedCosts: businessProfile.monthlyFixedCosts,
      }
    : null;

  const insights = await runCurationPipeline(orgId, datasetId, undefined, financials);
  const { system, user, metadata } = assemblePrompt(insights, undefined, businessProfile);

  const validatedMetadata = transparencyMetadataSchema.parse(metadata);

  logger.info(
    { orgId, datasetId, promptVersion: metadata.promptVersion, statCount: insights.length },
    'calling Claude API',
  );

  const content = await generateInterpretation({ system, user });
  const pipelineStats = insights.map((i) => i.stat);

  // Tier 2 chart-ref check — same defense-in-depth as streamHandler.ts.
  // Strip hallucinated stat refs before cache write so non-streaming
  // callers (seed generation, batch runs) don't pollute the cache.
  //
  // We return `cachedContent` (stripped) rather than raw `content` so the
  // first-call response matches what the next cache hit will return. The
  // alternative — returning raw on first call, stripped on later calls —
  // would set a trap where users see different text depending on cache state.
  //
  // No AI_CHART_REF_INVALID analytics emit here because runFullPipeline has
  // no userId/tier in scope (it's called from seed generation and batch
  // contexts, not a user request). The log.warn above is the observable
  // signal; streamHandler.ts is the only path that fires the analytics event.
  const refReport = validateStatRefs(content, pipelineStats);
  const cachedContent = refReport.invalidRefs.length > 0
    ? stripInvalidStatRefs(content, refReport.invalidRefs)
    : content;
  if (refReport.invalidRefs.length > 0) {
    logger.warn(
      { orgId, datasetId, invalidRefs: refReport.invalidRefs, promptVersion: metadata.promptVersion },
      'AI summary referenced unknown stat IDs — stripped before cache',
    );
  }

  const report = validateSummary(content, pipelineStats);
  if (report.status === 'clean') {
    logger.info(
      { orgId, datasetId, numbersChecked: report.numbersChecked },
      'AI summary validation clean',
    );
  } else {
    logger.warn(
      {
        orgId,
        datasetId,
        status: report.status,
        unmatched: report.unmatchedNumbers,
        promptVersion: metadata.promptVersion,
      },
      'AI summary validation flagged unmatched numbers',
    );
  }

  await aiSummariesQueries.storeSummary(
    orgId,
    datasetId,
    cachedContent,
    validatedMetadata,
    metadata.promptVersion,
  );

  logger.info({ orgId, datasetId }, 'ai summary stored in cache');

  return { content: cachedContent, fromCache: false };
}

export type { ComputedStat, ScoredInsight, ScoringConfig, AssembledContext, TransparencyMetadata } from './types.js';
export { StatType, transparencyMetadataSchema } from './types.js';
export { assemblePrompt } from './assembly.js';
export { validateSummary, validateStatRefs, stripInvalidStatRefs } from './validator.js';
export type { ValidationReport, UnmatchedNumber, ValidateOptions, StatRefReport } from './validator.js';
