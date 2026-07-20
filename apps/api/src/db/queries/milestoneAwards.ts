import { eq } from 'drizzle-orm';

import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { milestoneAwards, type MilestoneAwardKind } from '../schema.js';

type Client = typeof dbAdmin | DbTransaction;

export interface AwardMilestoneInput {
  orgId: number;
  kind: MilestoneAwardKind;
  datasetId: number | null;
}

export async function getAwardedKinds(orgId: number, client: Client = dbAdmin): Promise<Set<string>> {
  const rows = await client
    .select({ kind: milestoneAwards.kind })
    .from(milestoneAwards)
    .where(eq(milestoneAwards.orgId, orgId));
  return new Set(rows.map((r) => r.kind));
}

// Insert-or-ignore: the (org_id, kind) unique index is the fire-once
// guarantee, so a BullMQ retry re-detecting the same milestone no-ops here
// instead of erroring on the duplicate.
export async function awardMilestone(input: AwardMilestoneInput, client: Client = dbAdmin): Promise<void> {
  await client
    .insert(milestoneAwards)
    .values(input)
    .onConflictDoNothing({ target: [milestoneAwards.orgId, milestoneAwards.kind] });
}
