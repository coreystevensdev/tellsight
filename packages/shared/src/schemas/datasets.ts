import { z } from 'zod';

export const sourceTypeSchema = z.enum([
  'csv',
  'quickbooks',
  'xero',
  'stripe',
  'plaid',
]);

export const demoModeStateSchema = z.enum([
  'seed_only',
  'seed_plus_user',
  'user_only',
  'empty',
]);

export const datasetSchema = z.object({
  id: z.number().int(),
  orgId: z.number().int(),
  name: z.string().min(1).max(255),
  sourceType: sourceTypeSchema,
  isSeedData: z.boolean(),
  uploadedBy: z.number().int().nullable(),
  createdAt: z.coerce.date(),
});

export const columnValidationErrorSchema = z.object({
  column: z.string(),
  message: z.string(),
  row: z.number().int().optional(),
});

export const csvPreviewDataSchema = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.record(z.string())),
  rowCount: z.number().int(),
  validRowCount: z.number().int(),
  skippedRowCount: z.number().int(),
  columnTypes: z.record(z.enum(['date', 'number', 'text'])),
  warnings: z.array(z.string()),
  fileName: z.string(),
  previewToken: z.string(),
});

export const csvValidationErrorSchema = z.object({
  errors: z.array(columnValidationErrorSchema),
  fileName: z.string(),
});

export const dataRowSchema = z.object({
  id: z.number().int(),
  orgId: z.number().int(),
  datasetId: z.number().int(),
  sourceType: sourceTypeSchema,
  category: z.string().min(1).max(255),
  parentCategory: z.string().max(255).nullable(),
  date: z.coerce.date(),
  amount: z.string(), // numeric(12,2) returns string from Drizzle, parse in service layer
  label: z.string().max(255).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
});
