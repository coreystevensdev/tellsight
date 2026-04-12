import type { z } from 'zod';
import type {
  revenueTrendPointSchema,
  expenseBreakdownItemSchema,
  datasetDateRangeSchema,
  chartDataSchema,
} from '../schemas/charts.js';
import type { chartFiltersSchema } from '../schemas/filters.js';

export type RevenueTrendPoint = z.infer<typeof revenueTrendPointSchema>;
export type ExpenseBreakdownItem = z.infer<typeof expenseBreakdownItemSchema>;
export type ExpenseTrendPoint = Record<string, string | number>;
export type DatasetDateRange = z.infer<typeof datasetDateRangeSchema>;
export type ChartData = z.infer<typeof chartDataSchema>;
export type ChartFilters = z.infer<typeof chartFiltersSchema>;
