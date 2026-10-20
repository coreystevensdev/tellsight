import { and, asc, eq, sql } from 'drizzle-orm';
import { categoryPlanSchema } from 'shared/schemas';
import type { CategoryPlan } from 'shared/types';
import { db, type DbTransaction } from '../../lib/db.js';
import { categoryPlans } from '../schema.js';

type Client = typeof db | DbTransaction;

// numeric comes back from postgres as a string to avoid float drift, so every
// read crosses that boundary in one place rather than at each call site.
function toPlan(row: { category: string; plannedMonthly: string }): CategoryPlan {
  return { category: row.category, plannedMonthly: Number(row.plannedMonthly) };
}

export async function listCategoryPlans(orgId: number, client: Client = db): Promise<CategoryPlan[]> {
  const rows = await client
    .select({ category: categoryPlans.category, plannedMonthly: categoryPlans.plannedMonthly })
    .from(categoryPlans)
    .where(eq(categoryPlans.orgId, orgId))
    .orderBy(asc(categoryPlans.category));

  return rows.map(toPlan);
}

/**
 * Sets plans in bulk and returns the org's full set afterwards. Upsert rather
 * than replace: a category the caller omits keeps its plan, because the UI edits
 * the categories on screen and the dataset it was rendered from may not contain
 * every category the org has ever planned against.
 *
 * Postgres rejects an ON CONFLICT DO UPDATE that would touch the same row twice
 * in one statement, so a payload naming a category more than once is collapsed
 * first, last value winning.
 */
export async function upsertCategoryPlans(
  orgId: number,
  plans: CategoryPlan[],
  client: Client = db,
): Promise<CategoryPlan[]> {
  const byCategory = new Map<string, CategoryPlan>();
  for (const plan of plans) {
    const validated = categoryPlanSchema.parse(plan);
    byCategory.set(validated.category, validated);
  }

  if (byCategory.size > 0) {
    await client
      .insert(categoryPlans)
      .values(
        [...byCategory.values()].map((p) => ({
          orgId,
          category: p.category,
          plannedMonthly: p.plannedMonthly.toFixed(2),
        })),
      )
      .onConflictDoUpdate({
        target: [categoryPlans.orgId, categoryPlans.category],
        set: { plannedMonthly: sql`excluded.planned_monthly`, updatedAt: sql`now()` },
      });
  }

  return listCategoryPlans(orgId, client);
}

// Returns whether a row was actually removed, so the route can answer 404 for a
// category that never had a plan instead of a misleading 204.
export async function deleteCategoryPlan(
  orgId: number,
  category: string,
  client: Client = db,
): Promise<boolean> {
  const removed = await client
    .delete(categoryPlans)
    .where(and(eq(categoryPlans.orgId, orgId), eq(categoryPlans.category, category)))
    .returning({ id: categoryPlans.id });

  return removed.length > 0;
}
