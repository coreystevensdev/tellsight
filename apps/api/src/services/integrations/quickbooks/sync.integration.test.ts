import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../../lib/db.js';
import { orgs, datasets, dataRows } from '../../../db/schema.js';
import { upsertRows } from './sync.js';
import type { NormalizedQbRow } from './types.js';

// upsertRows never deleted anything until this change, so a transaction
// that used to produce rows and now produces fewer (or none) left the old
// ones behind. The obvious fix, delete every quickbooks row not in the
// newly produced set, would also delete every row belonging to a
// transaction this batch never fetched, since an incremental sync only
// fetches what changed. That failure mode needs two transactions in the
// same dataset to see at all; a single-transaction fixture has nothing
// else to delete, which is why the mocked unit tests in sync.test.ts
// cannot catch it and this suite runs against a real Postgres instead.

const suffix = `qb-reconcile-${process.pid}`;
let orgId: number;
let datasetId: number;

function row(overrides: Partial<NormalizedQbRow> & { sourceId: string }): NormalizedQbRow {
  return {
    sourceType: 'quickbooks',
    date: new Date('2026-04-10'),
    amount: '100.00',
    category: 'Uncategorized',
    parentCategory: 'Income',
    label: null,
    metadata: {
      // sourceId is `${qbId}-${lineId}` and the qb_id fixtures below (e.g.
      // 'txn-shrink') contain hyphens themselves, so this has to split on
      // the last '-', not the first.
      qb_id: overrides.sourceId.slice(0, overrides.sourceId.lastIndexOf('-')),
      txnType: 'Payment',
      docNumber: null,
      memo: null,
      accountCode: null,
    },
    ...overrides,
  };
}

async function sourceIdsFor(qbId: string): Promise<string[]> {
  const found = await dbAdmin.query.dataRows.findMany({
    where: and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)),
  });
  return found
    .filter((r) => (r.metadata as { qb_id?: string } | null)?.qb_id === qbId)
    .map((r) => r.sourceId!);
}

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'qb reconcile', slug: suffix })
    .returning({ id: orgs.id });
  orgId = org!.id;

  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId, name: 'QuickBooks' })
    .returning({ id: datasets.id });
  datasetId = dataset!.id;
});

afterAll(async () => {
  if (orgId) await dbAdmin.delete(orgs).where(eq(orgs.id, orgId));
});

describe('upsertRows reconciliation against real Postgres', () => {
  it('deletes a fetched transaction that now produces no rows, and leaves an unfetched transaction alone', async () => {
    // txn-a was already synced with one row. txn-b, a different transaction
    // in the same org and dataset, was already synced too. This batch only
    // fetched txn-a (an incremental sync fetches what changed; txn-b did
    // not), and txn-a's remainder is now fully applied, so the normalizer
    // produces no rows for it this time.
    await dbAdmin.insert(dataRows).values([
      { orgId, datasetId, ...row({ sourceId: 'txn-a-0' }) },
      { orgId, datasetId, ...row({ sourceId: 'txn-b-0' }) },
    ]);

    const result = await upsertRows(orgId, datasetId, ['txn-a'], []);

    expect(result.reconciled).toBe(1);
    expect(await sourceIdsFor('txn-a')).toEqual([]);
    expect(await sourceIdsFor('txn-b')).toEqual(['txn-b-0']);
  });

  it('deletes only the stale line when a transaction shrinks from two rows to one', async () => {
    // The $1,000 invoice / $400-applied shape from the design doc: a
    // partial payment that was synced as two rows (the invoice and the
    // $600 remainder) gets re-fetched after a $200 second payment, and now
    // normalizes to one row instead of two.
    await dbAdmin.insert(dataRows).values([
      { orgId, datasetId, ...row({ sourceId: 'txn-shrink-0' }) },
      { orgId, datasetId, ...row({ sourceId: 'txn-shrink-1' }) },
    ]);

    const result = await upsertRows(
      orgId,
      datasetId,
      ['txn-shrink'],
      [row({ sourceId: 'txn-shrink-0', amount: '400.00' })],
    );

    expect(result).toEqual({ upserted: 1, reconciled: 1 });
    expect(await sourceIdsFor('txn-shrink')).toEqual(['txn-shrink-0']);
  });

  it('never deletes a non-quickbooks row even if its jsonb metadata happens to carry a matching qb_id', async () => {
    // metadata is untyped jsonb shared with every other connector and CSV
    // upload. A predicate keyed on metadata->>'qb_id' without also pinning
    // source_type is one coincidental value away from deleting a customer's
    // uploaded data, which is the second anti-goal in the design doc.
    await dbAdmin.insert(dataRows).values({
      orgId,
      datasetId,
      sourceType: 'csv',
      sourceId: 'csv-row-1',
      category: 'Uncategorized',
      parentCategory: 'Income',
      date: new Date('2026-04-10'),
      amount: '50.00',
      label: null,
      metadata: { qb_id: 'txn-collide' },
    });

    await upsertRows(orgId, datasetId, ['txn-collide'], []);

    const survivors = await dbAdmin.query.dataRows.findMany({
      where: and(eq(dataRows.orgId, orgId), eq(dataRows.sourceId, 'csv-row-1')),
    });
    expect(survivors).toHaveLength(1);
  });

  it('inserts a newly fetched transaction without touching other rows in the dataset', async () => {
    await dbAdmin.insert(dataRows).values({
      orgId,
      datasetId,
      ...row({ sourceId: 'txn-untouched-0' }),
    });

    const result = await upsertRows(
      orgId,
      datasetId,
      ['txn-new'],
      [row({ sourceId: 'txn-new-0' })],
    );

    expect(result).toEqual({ upserted: 1, reconciled: 0 });
    expect(await sourceIdsFor('txn-new')).toEqual(['txn-new-0']);
    expect(await sourceIdsFor('txn-untouched')).toEqual(['txn-untouched-0']);
  });
});
