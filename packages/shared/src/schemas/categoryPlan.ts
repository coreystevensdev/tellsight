import { z } from 'zod';

// Ceiling matches businessProfile.monthlyFixedCosts rather than the numeric(12,2)
// column's real limit. The column is sized to match data_rows.amount so a
// comparison cannot drift; this cap is the product judgment, and a category
// budgeted above ten million a month is not this product's user.
export const categoryPlanSchema = z.object({
  category: z.string().min(1).max(255),
  // Zero is a real intent ("nothing on this next month"), so nonnegative rather
  // than positive. Absence of a plan is the row not existing.
  plannedMonthly: z.number().nonnegative().max(9_999_999),
});

export type CategoryPlan = z.infer<typeof categoryPlanSchema>;

// Bulk, because an owner sets a plan for several categories in one sitting and a
// per-category round trip would make the UI fight the API. Capped so one request
// cannot enqueue unbounded writes.
export const categoryPlansInputSchema = z.object({
  plans: z.array(categoryPlanSchema).max(100),
});

export type CategoryPlansInput = z.infer<typeof categoryPlansInputSchema>;
