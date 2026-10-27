import { z } from 'zod';

export const createShareSchema = z.object({
  datasetId: z.number().int().positive(),
});

export type CreateShareInput = z.infer<typeof createShareSchema>;

export const insightSnapshotSchema = z.object({
  orgName: z.string(),
  dateRange: z.string(),
  aiSummaryContent: z.string(),
  chartConfig: z.record(z.string(), z.unknown()),
});

export type InsightSnapshot = z.infer<typeof insightSnapshotSchema>;

export const shareResponseSchema = z.object({
  url: z.string().url(),
  token: z.string(),
  expiresAt: z.string(),
});

export type ShareResponse = z.infer<typeof shareResponseSchema>;
