import type { z } from 'zod';
import type {
  revenueTrendPointSchema,
  expenseBreakdownItemSchema,
  monthlyComparisonPointSchema,
  yoyComparisonPointSchema,
  datasetDateRangeSchema,
  chartDataSchema,
} from '../schemas/charts.js';
import type { chartFiltersSchema, granularitySchema } from '../schemas/filters.js';

export type Granularity = z.infer<typeof granularitySchema>;
export type RevenueTrendPoint = z.infer<typeof revenueTrendPointSchema>;
export type ExpenseBreakdownItem = z.infer<typeof expenseBreakdownItemSchema>;
export type ExpenseTrendPoint = Record<string, string | number>;
export type MonthlyComparisonPoint = z.infer<typeof monthlyComparisonPointSchema>;
export type YoyComparisonPoint = z.infer<typeof yoyComparisonPointSchema>;
export type DatasetDateRange = z.infer<typeof datasetDateRangeSchema>;
export type ChartData = z.infer<typeof chartDataSchema>;
export type ChartFilters = z.infer<typeof chartFiltersSchema>;
