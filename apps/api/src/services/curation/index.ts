import type { BusinessProfile } from 'shared/types';

import { logger } from '../../lib/logger.js';
import { dataRowsQueries, aiSummariesQueries } from '../../db/queries/index.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { computeStats } from './computation.js';
import { scoreInsights, scoringConfig } from './scoring.js';
import { assemblePrompt } from './assembly.js';
import { generateInterpretation } from '../aiInterpretation/claudeClient.js';
import { transparencyMetadataSchema } from './types.js';
import type { ScoredInsight } from './types.js';

export async function runCurationPipeline(
  orgId: number,
  datasetId: number,
  client?: typeof db | DbTransaction,
): Promise<ScoredInsight[]> {
  const rows = await dataRowsQueries.getRowsByDataset(orgId, datasetId, client);

  if (rows.length === 0) {
    logger.warn({ orgId, datasetId }, 'curation pipeline got 0 rows — dataset may not exist');
    return [];
  }

  logger.info({ orgId, datasetId, rowCount: rows.length }, 'curation pipeline started');

  const stats = computeStats(rows, {
    trendMinPoints: scoringConfig.thresholds.trendMinDataPoints,
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

  const insights = await runCurationPipeline(orgId, datasetId);
  const { prompt, metadata } = assemblePrompt(insights, undefined, businessProfile);

  const validatedMetadata = transparencyMetadataSchema.parse(metadata);

  logger.info(
    { orgId, datasetId, promptVersion: metadata.promptVersion, statCount: insights.length },
    'calling Claude API',
  );

  const content = await generateInterpretation(prompt);

  await aiSummariesQueries.storeSummary(
    orgId,
    datasetId,
    content,
    validatedMetadata,
    metadata.promptVersion,
  );

  logger.info({ orgId, datasetId }, 'ai summary stored in cache');

  return { content, fromCache: false };
}

export type { ComputedStat, ScoredInsight, ScoringConfig, AssembledContext, TransparencyMetadata } from './types.js';
export { StatType, transparencyMetadataSchema } from './types.js';
export { assemblePrompt } from './assembly.js';
