import { randomBytes } from 'node:crypto';
import * as orgsQueries from '../../db/queries/orgs.js';
import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import { dbAdmin } from '../../lib/db.js';

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

/** Shared by both Google OAuth and password sign-up: a brand-new user with no
 * invite gets their own org and becomes its owner. */
export async function createOwnerOrgForUser(userId: number, ownerName: string) {
  const orgName = `${ownerName}'s Organization`;
  const slug = await generateUniqueSlug(ownerName);
  const org = await orgsQueries.createOrg({ name: orgName, slug });
  const membership = await userOrgsQueries.addMember(org.id, userId, 'owner', dbAdmin);
  return { org, membership };
}
