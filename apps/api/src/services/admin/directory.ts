import { adminQueries } from '../../db/queries/index.js';
import { NotFoundError } from '../../lib/appError.js';

export async function getOrgsWithStats() {
  const [orgs, stats] = await Promise.all([
    adminQueries.getAllOrgs(),
    adminQueries.getAdminStats(),
  ]);
  return { orgs, stats };
}

export async function getUsers() {
  return adminQueries.getAllUsers();
}

export async function getOrgDetail(orgId: number) {
  const org = await adminQueries.getOrgDetail(orgId);
  if (!org) throw new NotFoundError(`Org ${orgId} not found`);
  return org;
}
