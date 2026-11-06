import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../../lib/db.js';
import { orgs, datasets, dataRows } from '../../../db/schema.js';
import { normalizeTransaction } from './normalize.js';
import { upsertRows } from './sync.js';
import type { NormalizedQbRow, QbTransaction, QbTransactionType } from './types.js';

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

function row(
  overrides: Partial<NormalizedQbRow> & {
    sourceId: string;
    qbId: string;
    txnType?: QbTransactionType;
  },
): NormalizedQbRow {
  // qbId is spelled out rather than sliced back off sourceId. It used to be
  // derived, which quietly turned a realistic key like 'Invoice-501-1' into
  // qb_id 'Invoice-501' and would have made a reconciliation assertion pass
  // for the wrong reason.
  const { txnType = 'Payment', qbId, ...rest } = overrides;
  return {
    sourceType: 'quickbooks',
    date: new Date('2026-04-10'),
    amount: '100.00',
    category: 'Uncategorized',
    parentCategory: 'Income',
    label: null,
    metadata: {
      qb_id: qbId,
      txnType,
      docNumber: null,
      memo: null,
      accountCode: null,
    },
    ...rest,
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
      { orgId, datasetId, ...row({ sourceId: 'txn-a-0', qbId: 'txn-a' }) },
      { orgId, datasetId, ...row({ sourceId: 'txn-b-0', qbId: 'txn-b' }) },
    ]);

    const result = await upsertRows(orgId, datasetId, 'Payment', ['txn-a'], []);

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
      { orgId, datasetId, ...row({ sourceId: 'txn-shrink-0', qbId: 'txn-shrink' }) },
      { orgId, datasetId, ...row({ sourceId: 'txn-shrink-1', qbId: 'txn-shrink' }) },
    ]);

    const result = await upsertRows(
      orgId,
      datasetId,
      'Payment',
      ['txn-shrink'],
      [row({ sourceId: 'txn-shrink-0', qbId: 'txn-shrink', amount: '400.00' })],
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

    await upsertRows(orgId, datasetId, 'Payment', ['txn-collide'], []);

    const survivors = await dbAdmin.query.dataRows.findMany({
      where: and(eq(dataRows.orgId, orgId), eq(dataRows.sourceId, 'csv-row-1')),
    });
    expect(survivors).toHaveLength(1);
  });

  it('inserts a newly fetched transaction without touching other rows in the dataset', async () => {
    await dbAdmin.insert(dataRows).values({
      orgId,
      datasetId,
      ...row({ sourceId: 'txn-untouched-0', qbId: 'txn-untouched' }),
    });

    const result = await upsertRows(
      orgId,
      datasetId,
      'Payment',
      ['txn-new'],
      [row({ sourceId: 'txn-new-0', qbId: 'txn-new' })],
    );

    expect(result).toEqual({ upserted: 1, reconciled: 0 });
    expect(await sourceIdsFor('txn-new')).toEqual(['txn-new-0']);
    expect(await sourceIdsFor('txn-untouched')).toEqual(['txn-untouched-0']);
  });

  // QuickBooks allocates Id per entity type, not globally, so an Invoice and
  // a Purchase can carry the exact same Id. metadata.qb_id alone cannot
  // tell them apart; this is the shape that let a Purchase batch delete an
  // Invoice's row.
  it('never deletes a different entity type that happens to share the same qb_id', async () => {
    await dbAdmin.insert(dataRows).values([
      { orgId, datasetId, ...row({ sourceId: '501-1', qbId: '501', txnType: 'Invoice' }) },
      { orgId, datasetId, ...row({ sourceId: '501-2', qbId: '501', txnType: 'Invoice' }) },
      { orgId, datasetId, ...row({ sourceId: '999-1', qbId: '999', txnType: 'Invoice' }) },
    ]);

    // A Purchase batch that happens to fetch an id of '501' and produces no
    // rows for it (Purchase 501's own shape is irrelevant here; what matters
    // is whether this call can reach Invoice 501's rows at all).
    const result = await upsertRows(orgId, datasetId, 'Purchase', ['501'], []);

    expect(result.reconciled).toBe(0);
    expect(await sourceIdsFor('501')).toEqual(expect.arrayContaining(['501-1', '501-2']));
    expect(await sourceIdsFor('999')).toEqual(['999-1']);
  });
});

// DW-237: source_id carried no entity type, so if QuickBooks allocates Id per
// type then an Invoice and a Purchase sharing one Id both produced "501-1" and
// the second upsert overwrote the first through the (org_id, source_id) unique
// index. The unit test asserts the two strings now differ; this one is here
// because a string comparison cannot show that the index accepts both rows.
describe('quickbooks source_id collisions across entity types', () => {
  it('keeps an Invoice and a Purchase that share an Id as two rows', async () => {
    const sharedId = '501';
    const invoice: QbTransaction = {
      Id: sharedId,
      TxnDate: '2026-04-12',
      DocNumber: 'INV-501',
      Line: [
        {
          Id: '1',
          Amount: 300,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: 'item-1', name: 'Consulting' } },
        },
      ],
    };
    const purchase: QbTransaction = {
      Id: sharedId,
      TxnDate: '2026-04-13',
      DocNumber: 'P-501',
      VendorRef: { value: '9', name: 'Acme Supplies' },
      Line: [
        {
          Id: '1',
          Amount: 80,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'acc-1', name: 'Office Supplies' },
          },
        },
      ],
    };

    const invoiceRows = normalizeTransaction(invoice, 'Invoice');
    const purchaseRows = normalizeTransaction(purchase, 'Purchase');

    await upsertRows(orgId, datasetId, 'Invoice', [sharedId], invoiceRows);
    await upsertRows(orgId, datasetId, 'Purchase', [sharedId], purchaseRows);

    // Both survive, and the amounts prove which row is which: before the fix
    // the second write replaced the first and only one amount remained.
    const stored = await dbAdmin.query.dataRows.findMany({
      where: and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)),
    });
    const collided = stored
      .filter((r) => (r.metadata as { qb_id?: string } | null)?.qb_id === sharedId)
      .map((r) => ({ sourceId: r.sourceId, amount: r.amount, parentCategory: r.parentCategory }))
      .sort((a, b) => a.sourceId!.localeCompare(b.sourceId!));

    expect(collided).toEqual([
      { sourceId: 'Invoice-501-1', amount: '300.00', parentCategory: 'Income' },
      { sourceId: 'Purchase-501-1', amount: '80.00', parentCategory: 'Expenses' },
    ]);
  });

  it('reconciles one entity type without touching the other type sharing its Id', async () => {
    // The reconciliation delete is scoped by txnType for exactly this reason:
    // keyed on qb_id alone, re-syncing the Purchase would delete the Invoice.
    const sharedId = '777';
    const invoiceRows = normalizeTransaction(
      {
        Id: sharedId,
        TxnDate: '2026-05-01',
        Line: [{ Id: '1', Amount: 50, DetailType: 'SalesItemLineDetail' }],
      },
      'Invoice',
    );
    const purchaseRows = normalizeTransaction(
      {
        Id: sharedId,
        TxnDate: '2026-05-02',
        Line: [{ Id: '1', Amount: 20, DetailType: 'AccountBasedExpenseLineDetail' }],
      },
      'Purchase',
    );
    await upsertRows(orgId, datasetId, 'Invoice', [sharedId], invoiceRows);
    await upsertRows(orgId, datasetId, 'Purchase', [sharedId], purchaseRows);

    // Re-sync the Purchase alone, now producing nothing for it.
    const result = await upsertRows(orgId, datasetId, 'Purchase', [sharedId], []);

    expect(result).toEqual({ upserted: 0, reconciled: 1 });
    expect(await sourceIdsFor(sharedId)).toEqual(['Invoice-777-1']);
  });
});
