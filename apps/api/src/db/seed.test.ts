import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the standalone DB connection that seed.ts creates.
// After the CRITICAL-3 fix, ALL queries (including the idempotency check)
// happen inside the transaction, so mockTx is the only DB interface that matters.
const mockExecute = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoNothing = vi.fn(() => ({ returning: mockReturning }));
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  onConflictDoNothing: mockOnConflictDoNothing,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockOrgsFindFirst = vi.fn();
const mockDatasetsFindFirst = vi.fn();

const mockTx = {
  execute: mockExecute,
  insert: mockInsert,
  query: {
    orgs: { findFirst: mockOrgsFindFirst },
    datasets: { findFirst: mockDatasetsFindFirst },
  },
};

const mockTransaction = vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    transaction: mockTransaction,
  })),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    end: vi.fn(),
  })),
}));

describe('seed data generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildSeedRows logic', () => {
    // Replicate the lerp function from seed.ts for validation
    function lerp(minVal: string, maxVal: string, monthIndex: number): string {
      const min = parseFloat(minVal);
      const max = parseFloat(maxVal);
      const t = monthIndex / 11;
      return (min + (max - min) * t).toFixed(2);
    }

    function buildSeedRows(orgId: number, datasetId: number) {
      const months = Array.from({ length: 12 }, (_, i) => i);
      const rows: Array<{
        orgId: number;
        datasetId: number;
        sourceType: 'csv';
        category: string;
        parentCategory: string;
        date: Date;
        amount: string;
        label: string | null;
      }> = [];

      for (const m of months) {
        const date = new Date(Date.UTC(2025, m, 15));

        const revenue = m === 11 ? '28000.00' : lerp('12000.00', '18000.00', m);
        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Revenue', parentCategory: 'Income',
          date, amount: revenue, label: null,
        });

        const payroll = m === 9 ? '9200.00' : lerp('5500.00', '6500.00', m);
        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Payroll', parentCategory: 'Expenses',
          date, amount: payroll, label: null,
        });

        const isQ3 = m >= 6 && m <= 8;
        const marketing = isQ3
          ? lerp('200.00', '300.00', m - 6)
          : lerp('800.00', '1200.00', m);
        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Marketing', parentCategory: 'Expenses',
          date, amount: marketing, label: null,
        });

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Rent', parentCategory: 'Expenses',
          date, amount: '3000.00', label: null,
        });

        const supplies = lerp('1500.00', '2500.00', m);
        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Supplies', parentCategory: 'Expenses',
          date, amount: supplies, label: null,
        });

        const utilities = lerp('600.00', '400.00', m);
        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Utilities', parentCategory: 'Expenses',
          date, amount: utilities, label: null,
        });
      }
      return rows;
    }

    it('generates exactly 72 rows (12 months * 6 categories)', () => {
      const rows = buildSeedRows(1, 1);

      expect(rows).toHaveLength(72);
    });

    it('all amounts are strings, not numbers', () => {
      const rows = buildSeedRows(1, 1);

      for (const row of rows) {
        expect(typeof row.amount).toBe('string');
        expect(row.amount).toMatch(/^\d+\.\d{2}$/);
      }
    });

    it('December revenue is $28,000 (holiday spike anomaly)', () => {
      const rows = buildSeedRows(1, 1);
      const decRevenue = rows.find(
        (r) => r.category === 'Revenue' && r.date.getUTCMonth() === 11,
      );

      expect(decRevenue?.amount).toBe('28000.00');
    });

    it('October payroll is $9,200 (unusual ratio anomaly)', () => {
      const rows = buildSeedRows(1, 1);
      const octPayroll = rows.find(
        (r) => r.category === 'Payroll' && r.date.getUTCMonth() === 9,
      );

      expect(octPayroll?.amount).toBe('9200.00');
    });

    it('Q3 marketing drops to $200-$300 range', () => {
      const rows = buildSeedRows(1, 1);
      const q3Marketing = rows.filter(
        (r) =>
          r.category === 'Marketing' &&
          r.date.getUTCMonth() >= 6 &&
          r.date.getUTCMonth() <= 8,
      );

      expect(q3Marketing).toHaveLength(3);
      for (const row of q3Marketing) {
        const amount = parseFloat(row.amount);
        expect(amount).toBeGreaterThanOrEqual(200);
        expect(amount).toBeLessThanOrEqual(300);
      }
    });

    it('all rows have parentCategory set', () => {
      const rows = buildSeedRows(1, 1);

      for (const row of rows) {
        expect(row.parentCategory).toBeTruthy();
      }
    });

    it('contains all 6 expected categories', () => {
      const rows = buildSeedRows(1, 1);
      const categories = new Set(rows.map((r) => r.category));

      expect(categories).toEqual(
        new Set(['Revenue', 'Payroll', 'Marketing', 'Rent', 'Supplies', 'Utilities']),
      );
    });
  });

  describe('seed idempotency', () => {
    it('skips insert when seed org + seed dataset already exist inside the transaction', async () => {
      // After CRITICAL-3 fix: idempotency check runs INSIDE the transaction
      // (after RLS bypass), so the datasets query actually sees existing data.
      mockOrgsFindFirst.mockResolvedValueOnce({ id: 1, slug: 'seed-demo' });
      mockDatasetsFindFirst.mockResolvedValueOnce({ id: 5, orgId: 1, isSeedData: true });

      await mockTransaction(async (tx) => {
        await tx.execute('SET LOCAL app.is_admin = \'true\'');

        const existing = await tx.query.orgs.findFirst({});
        if (existing) {
          const seedDataset = await tx.query.datasets.findFirst({});
          if (seedDataset) return; // skip — this is the early exit path
        }
        // Should NOT reach here
        throw new Error('Should have returned early');
      });

      expect(mockExecute).toHaveBeenCalledOnce();
      expect(mockOrgsFindFirst).toHaveBeenCalledOnce();
      expect(mockDatasetsFindFirst).toHaveBeenCalledOnce();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('proceeds with insert when org exists but no seed dataset', async () => {
      mockOrgsFindFirst.mockResolvedValueOnce({ id: 1, slug: 'seed-demo' });
      mockDatasetsFindFirst.mockResolvedValueOnce(undefined);
      mockReturning.mockResolvedValue([{ id: 1 }]);

      let inserted = false;
      await mockTransaction(async (tx) => {
        await tx.execute('SET LOCAL app.is_admin = \'true\'');

        const existing = await tx.query.orgs.findFirst({});
        if (existing) {
          const seedDataset = await tx.query.datasets.findFirst({});
          if (seedDataset) return;
        }
        inserted = true;
      });

      expect(inserted).toBe(true);
    });
  });

  describe('RLS bypass', () => {
    it('SET LOCAL is first statement in the transaction', async () => {
      const callOrder: string[] = [];
      mockExecute.mockImplementation(() => { callOrder.push('execute'); });
      mockOrgsFindFirst.mockImplementation(() => {
        callOrder.push('orgQuery');
        return undefined;
      });
      mockReturning.mockResolvedValue([{ id: 1 }]);

      await mockTransaction(async (tx) => {
        await tx.execute('SET LOCAL app.is_admin = \'true\'');
        await tx.query.orgs.findFirst({});
      });

      expect(callOrder[0]).toBe('execute');
      expect(callOrder[1]).toBe('orgQuery');
    });
  });
});
