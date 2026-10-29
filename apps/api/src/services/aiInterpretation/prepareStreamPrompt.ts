import type { BusinessProfile } from 'shared/types';

import type { db, DbTransaction } from '../../lib/db.js';
import {
  assemblePrompt,
  runCurationPipeline,
  transparencyMetadataSchema,
} from '../curation/index.js';
import type { ScoredInsight } from '../curation/index.js';

export interface PreparedStreamPrompt {
  promptInput: { system: string; user: string };
  validatedMetadata: ReturnType<typeof transparencyMetadataSchema.parse>;
  promptVersion: string;
  pipelineInsights: ScoredInsight[];
}

export async function prepareStreamPrompt(
  orgId: number,
  datasetId: number,
  client?: typeof db | DbTransaction,
  businessProfile?: BusinessProfile | null,
): Promise<PreparedStreamPrompt> {
  const pipelineInsights = await runCurationPipeline(orgId, datasetId, client);
  const { system, user, metadata } = assemblePrompt(
    pipelineInsights,
    datasetId,
    undefined,
    businessProfile,
  );

  return {
    promptInput: { system, user },
    validatedMetadata: transparencyMetadataSchema.parse(metadata),
    promptVersion: metadata.promptVersion,
    pipelineInsights,
  };
}
