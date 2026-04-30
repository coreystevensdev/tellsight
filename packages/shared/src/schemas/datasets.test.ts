import { describe, it, expect } from 'vitest';
import {
  sourceTypeSchema,
  demoModeStateSchema,
  datasetSchema,
  dataRowSchema,
} from './datasets';

describe('dataset schemas', () => {
  describe('sourceTypeSchema', () => {
    it('accepts valid source types', () => {
      expect(sourceTypeSchema.parse('csv')).toBe('csv');
      expect(sourceTypeSchema.parse('quickbooks')).toBe('quickbooks');
      expect(sourceTypeSchema.parse('xero')).toBe('xero');
      expect(sourceTypeSchema.parse('stripe')).toBe('stripe');
      expect(sourceTypeSchema.parse('plaid')).toBe('plaid');
    });

    it('rejects invalid source types', () => {
      expect(() => sourceTypeSchema.parse('excel')).toThrow();
      expect(() => sourceTypeSchema.parse('')).toThrow();
    });
  });

  describe('demoModeStateSchema', () => {
    it('accepts all 4 demo mode states', () => {
      expect(demoModeStateSchema.parse('seed_only')).toBe('seed_only');
      expect(demoModeStateSchema.parse('seed_plus_user')).toBe('seed_plus_user');
      expect(demoModeStateSchema.parse('user_only')).toBe('user_only');
      expect(demoModeStateSchema.parse('empty')).toBe('empty');
    });

    it('rejects invalid states', () => {
      expect(() => demoModeStateSchema.parse('unknown')).toThrow();
    });
  });

  describe('datasetSchema', () => {
    const validDataset = {
      id: 1,
      orgId: 10,
      name: 'Q1 Financials',
      sourceType: 'csv',
      isSeedData: false,
      uploadedBy: 5,
      createdAt: '2025-01-15T00:00:00Z',
    };

    it('validates a valid dataset', () => {
      const result = datasetSchema.parse(validDataset);

      expect(result.id).toBe(1);
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('allows null uploadedBy (seed data has no uploader)', () => {
      const result = datasetSchema.parse({ ...validDataset, uploadedBy: null });

      expect(result.uploadedBy).toBeNull();
    });

    it('rejects empty name', () => {
      expect(() => datasetSchema.parse({ ...validDataset, name: '' })).toThrow();
    });
  });

  describe('dataRowSchema', () => {
    const validRow = {
      id: 1,
      orgId: 10,
      datasetId: 1,
      sourceType: 'csv',
      category: 'Revenue',
      parentCategory: 'Income',
      date: '2025-01-15',
      amount: '12000.00',
      label: null,
      metadata: null,
      createdAt: '2025-01-15T00:00:00Z',
    };

    it('validates a valid data row', () => {
      const result = dataRowSchema.parse(validRow);

      expect(result.amount).toBe('12000.00');
      expect(typeof result.amount).toBe('string');
    });

    it('amount is a string, numeric(12,2) returns strings from Drizzle', () => {
      const result = dataRowSchema.parse(validRow);

      expect(typeof result.amount).toBe('string');
    });

    it('coerces date string to Date object', () => {
      const result = dataRowSchema.parse(validRow);

      expect(result.date).toBeInstanceOf(Date);
    });

    it('allows null parentCategory', () => {
      const result = dataRowSchema.parse({ ...validRow, parentCategory: null });

      expect(result.parentCategory).toBeNull();
    });

    it('allows metadata as record', () => {
      const result = dataRowSchema.parse({
        ...validRow,
        metadata: { notes: 'Holiday bonus included' },
      });

      expect(result.metadata).toEqual({ notes: 'Holiday bonus included' });
    });
  });
});
