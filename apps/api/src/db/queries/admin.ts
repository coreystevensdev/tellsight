import { eq, sql, count } from 'drizzle-orm';
import { estimateClaudeCostUsd } from 'shared/constants';
import { dbAdmin } from '../../lib/db.js';
import { orgs, users, userOrgs, datasets, subscriptions } from '../schema.js';
import { getMonthToDateAiUsage } from './analyticsEvents.js';

/**
 * Cross-org queries, no orgId param. Gated by roleGuard('admin') at the route layer.
 */

export async function getAllOrgs() {
  const rows = await dbAdmin
    .select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
      createdAt: orgs.createdAt,
      memberCount: sql<number>`cast(count(distinct ${userOrgs.userId}) as int)`,
      datasetCount: sql<number>`cast(count(distinct ${datasets.id}) as int)`,
      subscriptionTier: subscriptions.plan,
    })
    .from(orgs)
    .leftJoin(userOrgs, eq(userOrgs.orgId, orgs.id))
    .leftJoin(datasets, eq(datasets.orgId, orgs.id))
    .leftJoin(subscriptions, eq(subscriptions.orgId, orgs.id))
    .groupBy(orgs.id, subscriptions.plan)
    .orderBy(orgs.createdAt);

  return rows;
}

export async function getAllUsers() {
  const rows = await dbAdmin
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);

  // grab org memberships in a separate query to avoid cross-join blowup
  const memberships = await dbAdmin
    .select({
      userId: userOrgs.userId,
      orgId: orgs.id,
      orgName: orgs.name,
      role: userOrgs.role,
    })
    .from(userOrgs)
    .innerJoin(orgs, eq(orgs.id, userOrgs.orgId));

  const membershipsByUser = new Map<number, Array<{ orgId: number; orgName: string; role: string }>>();
  for (const m of memberships) {
    const list = membershipsByUser.get(m.userId) ?? [];
    list.push({ orgId: m.orgId, orgName: m.orgName, role: m.role });
    membershipsByUser.set(m.userId, list);
  }

  return rows.map((u) => ({
    ...u,
    orgs: membershipsByUser.get(u.id) ?? [],
  }));
}

export async function getOrgDetail(orgId: number) {
  const [org] = await dbAdmin
    .select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
      createdAt: orgs.createdAt,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId));

  if (!org) return null;

  const members = await dbAdmin
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: userOrgs.role,
      isPlatformAdmin: users.isPlatformAdmin,
      joinedAt: userOrgs.joinedAt,
    })
    .from(userOrgs)
    .innerJoin(users, eq(users.id, userOrgs.userId))
    .where(eq(userOrgs.orgId, orgId));

  const datasetRows = await dbAdmin
    .select({ id: datasets.id, name: datasets.name, isSeedData: datasets.isSeedData, createdAt: datasets.createdAt })
    .from(datasets)
    .where(eq(datasets.orgId, orgId));

  const [sub] = await dbAdmin
    .select({ plan: subscriptions.plan, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId));

  return {
    ...org,
    members,
    datasets: datasetRows,
    subscription: sub ?? null,
  };
}

export async function getAdminStats() {
  const [[orgCount], [userCount], [proCount], aiUsage] = await Promise.all([
    dbAdmin.select({ value: count() }).from(orgs),
    dbAdmin.select({ value: count() }).from(users),
    dbAdmin.select({ value: count() }).from(subscriptions).where(eq(subscriptions.plan, 'pro')),
    getMonthToDateAiUsage(),
  ]);

  return {
    totalOrgs: orgCount?.value ?? 0,
    totalUsers: userCount?.value ?? 0,
    proSubscribers: proCount?.value ?? 0,
    aiUsage: {
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      requestCount: aiUsage.requestCount,
      // Estimated cost from month-to-date token totals against the default
      // model's rate card. Treat as a rough operational signal, not an
      // invoice, actual Anthropic billing depends on the model variant
      // selected per request and any prompt caching discounts.
      estimatedCostUsd: estimateClaudeCostUsd(aiUsage.inputTokens, aiUsage.outputTokens),
    },
  };
}
