import { eq, desc, and, lt } from 'drizzle-orm';

import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { digestHistory } from '../schema.js';
import { MONTH_NAMES } from '../../services/curation/computation.js';
import { StatType, type ComputedStat } from '../../services/curation/types.js';

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

const VALID_STAT_TYPES: ReadonlySet<string> = new Set(Object.values(StatType));

// statDiscriminator (computation.ts) is called on every keyStats match inside
// compareToPriorPeriods (via statInstanceId, for the excludedStatIds check),
// and it dereferences these details fields with no guard of its own. Total
// and Average also dereference details.scope there, but neither is a
// TrendCarryingStatType so compareToPriorPeriods can never match one -- their
// case is still checked below so this guard holds even if that changes.
// Every other stat type's discriminator branch is a fixed placeholder.
function hasValidDiscriminatorFields(stat: { statType: string; details: unknown }): boolean {
  const details = stat.details as Record<string, unknown> | null | undefined;
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return typeof details?.scope === 'string';
    case StatType.YearOverYear:
      return (
        typeof details?.currentYear === 'number' &&
        Number.isFinite(details.currentYear) &&
        typeof details?.month === 'string' &&
        (MONTH_NAMES as readonly string[]).includes(details.month)
      );
    case StatType.SeasonalProjection:
      return typeof details?.projectedMonth === 'string';
    case StatType.CashFlow:
      return typeof details?.trailingMonths === 'number' && Number.isFinite(details.trailingMonths);
    default:
      return true;
  }
}

// compareToPriorPeriods (interpretationTools.ts) reads statType, category, and
// value off a cast keyStats entry, then calls statInstanceId on the same match
// (see hasValidDiscriminatorFields above) before citing it to the model -- both
// surfaces are validated here.
function isComputedStat(value: unknown): value is ComputedStat {
  if (typeof value !== 'object' || value === null) return false;
  const stat = value as Record<string, unknown>;
  if (
    typeof stat.statType !== 'string' ||
    !VALID_STAT_TYPES.has(stat.statType) ||
    !(stat.category === null || typeof stat.category === 'string') ||
    typeof stat.value !== 'number' ||
    !Number.isFinite(stat.value)
  ) {
    return false;
  }
  return hasValidDiscriminatorFields(stat as { statType: string; details: unknown });
}

function isDigestMilestone(value: unknown): value is DigestMilestone {
  if (typeof value !== 'object' || value === null) return false;
  const milestone = value as Record<string, unknown>;
  return (
    typeof milestone.kind === 'string' &&
    typeof milestone.label === 'string' &&
    (milestone.catalog === 'first_time' || milestone.catalog === 'transition')
  );
}

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
  if (!row) return row;
  return {
    ...row,
    // key_stats is stored as untyped jsonb; cast at the query-helper layer per
    // schema.ts's comment on the column ("typed at the query-helper layer"), no
    // runtime validation added here -- spec-digest-lastdigest-hardening.md's
    // explicit prior scope decision, unchanged by this bundle.
    keyStats: row.keyStats as ComputedStat[],
    milestones: Array.isArray(row.milestones) ? row.milestones.filter(isDigestMilestone) : [],
  };
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
  return rows.map((row) => ({
    ...row,
    // key_stats is untyped jsonb; this cast now also feeds compare_to_prior_periods
    // (a model-facing tool), so entries failing the ComputedStat shape check are
    // dropped rather than cast through unchecked like getLastDigest's keyStats.
    keyStats: Array.isArray(row.keyStats) ? row.keyStats.filter(isComputedStat) : [],
  }));
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
