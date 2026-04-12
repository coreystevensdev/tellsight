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

export const chartDataSchema = z.object({
  revenueTrend: z.array(revenueTrendPointSchema),
  expenseBreakdown: z.array(expenseBreakdownItemSchema),
  expenseTrend: z.array(expenseTrendPointSchema),
  orgName: z.string(),
  isDemo: z.boolean(),
  availableCategories: z.array(z.string()),
  dateRange: datasetDateRangeSchema.nullable(),
  demoState: demoModeStateSchema,
  datasetId: z.number().nullable(),
});
