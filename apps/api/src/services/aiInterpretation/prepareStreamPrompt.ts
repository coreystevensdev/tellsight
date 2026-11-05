import type { BusinessProfile } from 'shared/types';

import type { db, DbTransaction } from '../../lib/db.js';
import {
  assemblePrompt,
  runCurationPipeline,
  transparencyMetadataSchema,
} from '../curation/index.js';
import type { ComputedStat } from '../curation/index.js';

export interface PreparedStreamPrompt {
  promptInput: { system: string; user: string };
  validatedMetadata: ReturnType<typeof transparencyMetadataSchema.parse>;
  promptVersion: string;
  // The stats the prompt actually carried, post sample-size gate -- what
  // finalizeStreamSummary's Tier 2 validators need to check the model's
  // output against.
  promptedStats: ComputedStat[];
}

export async function prepareStreamPrompt(
  orgId: number,
  datasetId: number,
  client?: typeof db | DbTransaction,
  businessProfile?: BusinessProfile | null,
): Promise<PreparedStreamPrompt> {
  const { scoredPool } = await runCurationPipeline(orgId, datasetId, client);
  const { system, user, metadata, promptedStats } = assemblePrompt(
    scoredPool,
    datasetId,
    undefined,
    businessProfile,
  );

  return {
    promptInput: { system, user },
    validatedMetadata: transparencyMetadataSchema.parse(metadata),
    promptVersion: metadata.promptVersion,
    promptedStats,
  };
}
