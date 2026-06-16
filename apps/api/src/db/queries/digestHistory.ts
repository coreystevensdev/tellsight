import { eq, desc } from 'drizzle-orm';

import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { digestHistory } from '../schema.js';
import type { ComputedStat } from '../../services/curation/types.js';

export type DigestValence = 'positive' | 'concerning' | 'watching' | 'neutral';

// Forward-looking shape for the milestone detector that lands with digest v2.
// Stored as JSONB so the detector can extend it without a migration.
export interface DigestMilestone {
  kind: string;
  label: string;
}

export interface SaveDigestHistoryInput {
  orgId: number;
  datasetId: number | null;
  summaryId: number | null;
  weekStart: Date;
  subjectLine: string;
  stateSentence: string;
  valence: DigestValence;
  keyStats: ComputedStat[];
  milestones: DigestMilestone[];
  sentAt: Date;
}

// Worker context: digest jobs run outside any user session, so these default to
// dbAdmin (RLS admin-bypass policy). A test or transaction can pass its own client.
type Client = typeof dbAdmin | DbTransaction;

export async function getLastDigest(orgId: number, client: Client = dbAdmin) {
  return client.query.digestHistory.findFirst({
    where: eq(digestHistory.orgId, orgId),
    orderBy: desc(digestHistory.weekStart),
  });
}

export async function getTrailingDigests(
  orgId: number,
  limit: number,
  client: Client = dbAdmin,
) {
  return client.query.digestHistory.findMany({
    where: eq(digestHistory.orgId, orgId),
    orderBy: desc(digestHistory.weekStart),
    limit,
  });
}

// Append-only write of one week's delivery record. The (org_id, week_start)
// unique index is the BullMQ-retry guard: if a send job is re-enqueued after a
// transient failure, the second attempt must not create a duplicate week.
//
// TODO(you): implement the insert. The decision worth making is what happens
// when the unique index is hit on a retry. See the prompt for the trade-offs.
export async function saveDigestHistory(
  input: SaveDigestHistoryInput,
  client: Client = dbAdmin,
): Promise<void> {
  // Insert-or-ignore: the (org_id, week_start) unique index is the retry guard,
  // so a re-enqueued send job no-ops instead of duplicating the week. First
  // write wins, which is what we want for an immutable delivery record.
  await client
    .insert(digestHistory)
    .values(input)
    .onConflictDoNothing({ target: [digestHistory.orgId, digestHistory.weekStart] });
}
