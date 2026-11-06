import { z } from 'zod';
import { demoModeStateSchema } from './datasets.js';

export const revenueTrendPointSchema = z.object({
  month: z.string(),
  revenue: z.number(),
});

export const expenseBreakdownItemSchema = z.object({
  category: z.string(),
  total: z.number(),
});

export const datasetDateRangeSchema = z.object({
  min: z.string(),
  max: z.string(),
});

export const expenseTrendPointSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export const monthlyComparisonPointSchema = z.object({
  month: z.string(),
  revenue: z.number(),
  expenses: z.number(),
  profit: z.number(),
});

export const yoyComparisonPointSchema = z.object({
  month: z.string(),
  // Revenue dollars, not years; the years are the Label fields below.
  currentRevenue: z.number(),
  priorRevenue: z.number(),
  changePercent: z.number().nullable(),
  currentYearLabel: z.string(),
  priorYearLabel: z.string(),
});

// monthLabel rides on every item rather than once at the top level, matching
// CategoryVarianceDetails (api categoryMetrics.ts) which this mirrors on the
// chart side. direction is its own field rather than derived from the sign of
// variance at render time: for spend, over plan is bad, the opposite of the
// bridge chart's profit deltas, so a sign check alone would paint an
// overspend green.
export const categoryVarianceItemSchema = z.object({
  category: z.string(),
  plannedMonthly: z.number(),
  actualMonthly: z.number(),
  variance: z.number(),
  variancePercent: z.number(),
  monthLabel: z.string(),
  direction: z.enum(['over', 'under', 'on_plan']),
});

export const chartDataSchema = z.object({
  revenueTrend: z.array(revenueTrendPointSchema),
  expenseBreakdown: z.array(expenseBreakdownItemSchema),
  expenseTrend: z.array(expenseTrendPointSchema),
  monthlyComparison: z.array(monthlyComparisonPointSchema),
  yoyComparison: z.array(yoyComparisonPointSchema),
  orgName: z.string(),
  isDemo: z.boolean(),
  availableCategories: z.array(z.string()),
  dateRange: datasetDateRangeSchema.nullable(),
  demoState: demoModeStateSchema,
  datasetId: z.number().nullable(),
  datasetName: z.string().nullable().optional(),
  datasetRowCount: z.number().optional(),
  // True when the org has at least 4 months of rows with both Income and Expenses
  // present, the same threshold computeMarginTrend uses to emit. Lets the UI
  // decide whether to show the "Enable Break-Even" locked card without waiting
  // on the AI summary to stream.
  hasMarginSignal: z.boolean().optional(),
  // When the weekly digest stops, because nothing new has arrived. Computed
  // server-side from the same constant the eligibility gate uses, so the
  // browser never carries a second copy of the rule.
  digestPausesAt: z.string().nullable().optional(),
  // Plan vs actual for the latest complete calendar month, pinned server-side
  // independent of the dashboard's date filter (plannedMonthly is a monthly
  // figure; the filter is not). Optional only so this schema stays a
  // type-only contract the five existing ChartData fixtures don't have to
  // touch; the route always sends the field, empty array when there are no
  // plans.
  categoryVariance: z.array(categoryVarianceItemSchema).optional(),
});
