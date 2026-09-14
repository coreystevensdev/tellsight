import { z } from 'zod';

// No .default('monthly') here, deliberately. It used to carry one, and chaining
// .optional() after it in chartFiltersSchema made it inert: zod 3 parses {} to
// {} and the default never fires. Monthly is applied where it is actually
// decided, in getCharts (`filters?.granularity ?? 'monthly'`), and an absent
// granularity has to stay absent because the charts route reads "no granularity"
// as "this request is unfiltered".
export const granularitySchema = z.enum(['weekly', 'monthly']);

export const chartFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  categories: z.array(z.string().max(100)).max(20).optional(),
  granularity: granularitySchema.optional(),
});
