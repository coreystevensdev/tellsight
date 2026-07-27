import { eq, desc, and, lt } from 'drizzle-orm';

import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { digestHistory } from '../schema.js';
import type { ComputedStat } from '../../services/curation/types.js';

export type DigestValence = 'positive' | 'concerning' | 'watching' | 'neutral';

// 'first_time' = all-time-first (FirstTimeMilestoneKind, DB-enforced via
// milestone_awards). 'transition' = week-over-week crossing (MilestoneKind,
// jsonb-only). digest_history_milestones_catalog_check enforces these two
// values at the row level.
export type MilestoneCatalog = 'first_time' | 'transition';

// Forward-looking shape for the milestone detector that lands with digest v2.
// Stored as JSONB so the detector can extend it without a migration.
export interface DigestMilestone {
  kind: string;
  label: string;
  catalog: MilestoneCatalog;
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

export async function getLastDigest(
  orgId: number,
  excludeWeekStart?: Date,
  client: Client = dbAdmin,
) {
  // excludeWeekStart keeps a retried run from reading back its own just-saved
  // row as "last digest" (job retries after saveDigestHistory already committed).
  const conditions = [eq(digestHistory.orgId, orgId)];
  if (excludeWeekStart) conditions.push(lt(digestHistory.weekStart, excludeWeekStart));

  const row = await client.query.digestHistory.findFirst({
    where: and(...conditions),
    orderBy: desc(digestHistory.weekStart),
  });
  // key_stats is stored as untyped jsonb; cast at the query-helper layer per
  // schema.ts's comment on the column ("typed at the query-helper layer"),
  // no runtime validation added here.
  return row ? { ...row, keyStats: row.keyStats as ComputedStat[] } : row;
}

export async function getTrailingDigests(
  orgId: number,
  limit: number,
  client: Client = dbAdmin,
) {
  const rows = await client.query.digestHistory.findMany({
    where: eq(digestHistory.orgId, orgId),
    orderBy: desc(digestHistory.weekStart),
    limit,
  });
  // key_stats is stored as untyped jsonb, cast at the query-helper layer
  // like getLastDigest does, so callers never see the raw jsonb column type.
  return rows.map((row) => ({ ...row, keyStats: row.keyStats as ComputedStat[] }));
}

// Append-only write of one week's delivery record. The (org_id, week_start)
// unique index is the BullMQ-retry guard: if a send job is re-enqueued after a
// transient failure, the second attempt must not create a duplicate week.
//
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
