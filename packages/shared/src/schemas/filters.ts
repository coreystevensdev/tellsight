import { z } from 'zod';

export const granularitySchema = z.enum(['weekly', 'monthly']).default('monthly');

export const chartFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  categories: z.array(z.string().max(100)).max(20).optional(),
  granularity: granularitySchema.optional(),
});
