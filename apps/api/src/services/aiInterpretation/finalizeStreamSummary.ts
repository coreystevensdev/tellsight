import type { SubscriptionTier } from '../../db/queries/subscriptions.js';
import { aiSummariesQueries } from '../../db/queries/index.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { findDirectiveLanguage } from 'shared/agent';
import { trackEvent } from '../analytics/trackEvent.js';
import {
  stripInvalidCiteRefs,
  stripInvalidStatRefs,
  validateCiteRefs,
  validateStatRefs,
  validateSummary,
} from '../curation/index.js';
import type { ScoredInsight } from '../curation/index.js';
import { transparencyMetadataSchema } from '../curation/index.js';

interface FinalizeStreamSummaryInput {
  orgId: number;
  datasetId: number;
  userId: number;
  tier: SubscriptionTier;
  promptVersion: string;
  fullText: string;
  pipelineInsights: ScoredInsight[];
  metadata: ReturnType<typeof transparencyMetadataSchema.parse>;
  client?: typeof db | DbTransaction;
}

export async function finalizeStreamSummary({
  orgId,
  datasetId,
  userId,
  tier,
  promptVersion,
  fullText,
  pipelineInsights,
  metadata,
  client,
}: FinalizeStreamSummaryInput): Promise<void> {
  const pipelineStats = pipelineInsights.map((insight) => insight.stat);
  const statRefReport = validateStatRefs(fullText, pipelineStats);
  let cachedText = fullText;
  if (statRefReport.invalidRefs.length > 0) {
    cachedText = stripInvalidStatRefs(fullText, statRefReport.invalidRefs);
    logger.warn(
      { orgId, datasetId, invalidRefs: statRefReport.invalidRefs, promptVersion },
      'AI summary referenced unknown stat IDs, stripped before cache',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_CHART_REF_INVALID, {
      datasetId,
      tier,
      promptVersion,
      invalidRefs: statRefReport.invalidRefs,
      validStatIds: pipelineStats.map((stat) => stat.statType),
    });
  }

  const citeReport = validateCiteRefs(cachedText, pipelineStats, datasetId);
  if (citeReport.invalidRefs.length > 0) {
    cachedText = stripInvalidCiteRefs(cachedText, citeReport.invalidRefs);
    logger.warn(
      { orgId, datasetId, invalidRefs: citeReport.invalidRefs, promptVersion },
      'AI summary referenced unknown stat instance IDs, stripped before cache',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_CITE_REF_INVALID, {
      datasetId,
      tier,
      promptVersion,
      invalidRefs: citeReport.invalidRefs,
    });
  }

  const validationReport = validateSummary(fullText, pipelineStats);
  if (validationReport.status === 'clean') {
    logger.info(
      {
        orgId,
        datasetId,
        numbersChecked: validationReport.numbersChecked,
        allowedValueCount: validationReport.allowedValueCount,
      },
      'AI summary validation clean',
    );
  } else {
    logger.warn(
      {
        orgId,
        datasetId,
        status: validationReport.status,
        numbersChecked: validationReport.numbersChecked,
        unmatched: validationReport.unmatchedNumbers,
        promptVersion,
      },
      'AI summary validation flagged unmatched numbers',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_VALIDATION_FLAGGED, {
      datasetId,
      tier,
      promptVersion,
      status: validationReport.status,
      numbersChecked: validationReport.numbersChecked,
      unmatchedCount: validationReport.unmatchedNumbers.length,
      unmatchedSample: validationReport.unmatchedNumbers.slice(0, 3),
    });
  }

  const directivePhrases = findDirectiveLanguage(fullText);
  if (directivePhrases.length > 0) {
    logger.warn(
      { orgId, datasetId, phrases: directivePhrases, promptVersion },
      'AI summary contained banned directive language',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_DIRECTIVE_LANGUAGE_FLAGGED, {
      datasetId,
      tier,
      promptVersion,
      phrases: directivePhrases,
    });
  }

  try {
    await aiSummariesQueries.storeSummary({
      orgId,
      datasetId,
      content: cachedText,
      metadata,
      promptVersion,
      client,
    });
    logger.info({ orgId, datasetId }, 'AI summary streamed and cached');
  } catch (cacheErr) {
    logger.warn(
      { orgId, datasetId, err: (cacheErr as Error).message },
      'failed to cache AI summary, stream already delivered',
    );
  }
}
