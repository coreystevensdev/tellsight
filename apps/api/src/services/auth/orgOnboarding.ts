import { randomBytes } from 'node:crypto';
import * as orgsQueries from '../../db/queries/orgs.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import * as datasetsQueries from '../../db/queries/datasets.js';
import * as dataRowsQueries from '../../db/queries/dataRows.js';
import { buildSeedRows, SEED_DATASET_NAME } from '../../db/seedData.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'org';
  const slug = `${base}-org`;

  const existing = await orgsQueries.findOrgBySlug(slug);
  if (!existing) return slug;

  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = randomBytes(2).toString('hex');
    const candidateSlug = `${base}-org-${suffix}`;
    const conflict = await orgsQueries.findOrgBySlug(candidateSlug);
    if (!conflict) return candidateSlug;
  }

  // Fallback: use full random slug
  return `org-${randomBytes(4).toString('hex')}`;
}

/** The new org opens on the same demo data the signed-out dashboard shows, so the
 *  first screen after sign-up has something to interpret instead of an empty state.
 *  Rows are generated fresh rather than copied from the demo org: the generator ends
 *  at the current month, so a copy would inherit whenever that org was last seeded.
 *
 *  dbAdmin because RLS scopes a session to one org and this writes to an org the
 *  caller has no session for yet. One transaction, so a dataset never survives
 *  without its rows and leaves the dashboard pointed at nothing. */
async function seedDemoData(orgId: number) {
  const rows = buildSeedRows();
  await dbAdmin.transaction(async (tx) => {
    const dataset = await datasetsQueries.createDataset(
      orgId,
      { name: SEED_DATASET_NAME, sourceType: 'csv', isSeedData: true },
      tx,
    );
    await dataRowsQueries.insertBatch(orgId, dataset.id, rows, tx);
  });
}

/** Shared by both Google OAuth and password sign-up: a brand-new user with no
 * invite gets their own org and becomes its owner. */
export async function createOwnerOrgForUser(userId: number, ownerName: string) {
  const orgName = `${ownerName}'s Organization`;
  const slug = await generateUniqueSlug(ownerName);
  const org = await orgsQueries.createOrg({ name: orgName, slug });
  const membership = await userOrgsQueries.addMember(org.id, userId, 'owner', dbAdmin);

  // An org with no demo data is the old behaviour, which is survivable. Failing
  // sign-up over it is not.
  try {
    await seedDemoData(org.id);
  } catch (err) {
    logger.error({ err, orgId: org.id }, 'Failed to seed demo data for new org');
  }

  return { org, membership };
}

/**
 * The org to sign someone in to, creating one if they have none left.
 *
 * Until member removal existed a user with no memberships could not occur, and
 * all three sign-in paths threw "User has no organization membership" at one.
 * Now they can occur: someone who joined by invite never got an org of their own,
 * so removing them leaves them with nothing, unable to sign in and therefore
 * unable to delete their own account either, since that route is behind auth.
 *
 * Giving them one back turns a removal into a removal rather than a locked door,
 * and matches the rule the rest of the product already holds to, that a user has
 * an org. They land on the same seeded demo a new sign-up gets.
 */
export async function resolvePrimaryMembership(userId: number, ownerName: string) {
  const [existing] = await userOrgsQueries.getUserOrgs(userId, dbAdmin);
  if (existing) return existing;

  logger.info({ userId }, 'Signing in a user with no org, creating one');
  const { org, membership } = await createOwnerOrgForUser(userId, ownerName);
  return { ...membership, org };
}
