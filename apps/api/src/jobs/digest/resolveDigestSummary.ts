import type { BusinessProfile } from 'shared/types';

import { aiSummariesQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { generateInterpretation } from '../../services/aiInterpretation/claudeClient.js';
import {
  assemblePrompt,
  stripInvalidCiteRefs,
  stripInvalidStatRefs,
  transparencyMetadataSchema,
  validateCiteRefs,
  validateStatRefs,
} from '../../services/curation/index.js';
import type { ScoredInsight } from '../../services/curation/types.js';

const DIGEST_AUDIENCE = 'digest-weekly' as const;

interface ResolveDigestSummaryInput {
  orgId: number;
  datasetId: number;
  weekStart: Date;
  promptVersion: string;
  businessProfile: BusinessProfile | null;
  priorContext: string;
  // The full ranked pool (runCurationPipeline's scoredPool), not the
  // already-capped insights array -- assemblePrompt fills the prompt's topN
  // slots from whichever of these clear the sample-size floor.
  candidates: ScoredInsight[];
}

export interface ResolvedDigestSummary {
  summaryId: number;
  cacheHit: boolean;
  insightCount: number;
  content: string;
  generatedPromptVersion: string;
}

export async function resolveDigestSummary({
  orgId,
  datasetId,
  weekStart,
  promptVersion,
  businessProfile,
  priorContext,
  candidates,
}: ResolveDigestSummaryInput): Promise<ResolvedDigestSummary> {
  const cached = await aiSummariesQueries.getCachedDigest(
    orgId,
    datasetId,
    weekStart,
    dbAdmin,
  );
  if (cached) {
    const metadata = cached.transparencyMetadata as {
      statTypes?: unknown[];
      promptVersion?: string;
    } | null;
    return {
      summaryId: cached.id,
      cacheHit: true,
      insightCount: Array.isArray(metadata?.statTypes) ? metadata.statTypes.length : 0,
      content: cached.content,
      generatedPromptVersion: metadata?.promptVersion ?? promptVersion,
    };
  }

  const { system, user, metadata, promptedStats } = assemblePrompt(
    candidates,
    datasetId,
    promptVersion,
    businessProfile,
    new Date(),
    priorContext,
  );
  const validatedMetadata = transparencyMetadataSchema.parse(metadata);
  const generated = await generateInterpretation({ system, user });

  const statRefReport = validateStatRefs(generated, promptedStats);
  const chartRefsStripped =
    statRefReport.invalidRefs.length > 0
      ? stripInvalidStatRefs(generated, statRefReport.invalidRefs)
      : generated;

  const citeReport = validateCiteRefs(chartRefsStripped, promptedStats, datasetId);
  const content =
    citeReport.invalidRefs.length > 0
      ? stripInvalidCiteRefs(chartRefsStripped, citeReport.invalidRefs)
      : chartRefsStripped;
  if (citeReport.invalidRefs.length > 0) {
    logger.warn(
      { orgId, datasetId, invalidRefs: citeReport.invalidRefs, promptVersion },
      'AI summary referenced unknown stat instance IDs, stripped before cache',
    );
  }

  const stored = await aiSummariesQueries.storeSummary({
    orgId,
    datasetId,
    content,
    metadata: validatedMetadata,
    promptVersion,
    audience: DIGEST_AUDIENCE,
    weekStart,
    client: dbAdmin,
  });

  return {
    summaryId: stored.id,
    cacheHit: false,
    insightCount: metadata.insightCount,
    content,
    generatedPromptVersion: promptVersion,
  };
}
