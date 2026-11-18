import { and, eq, inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../../lib/db.js';
import { dataRows, datasets, integrationConnections, orgs } from '../../../db/schema.js';
import { upsert } from '../../../db/queries/integrationConnections.js';
import { writeChanges } from './sync.js';
import type { NormalizedPlaidRow } from './normalize.js';

// writeChanges is the only part of the Plaid connector a unit test cannot see.
// A mocked insert records the object it was handed, not what Postgres did with
// it on conflict, and the conflict path is where the interesting failures live:
// the set clause has to name every column or an existing row keeps its old
// value, which is how QuickBooks' counterparty stayed 0 of 142 for a day.
//
// The cursor write is the other reason. It is deliberately inside the same
// transaction as the rows, and only a real rollback shows that holding.

const createdOrgs: number[] = [];

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

async function seed(label: string) {
  const suffix = `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `Plaid ${suffix}`, slug: `plaid-${suffix}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);

  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId: org!.id, name: `Bank, ${suffix}`, sourceType: 'plaid' })
    .returning({ id: datasets.id });

  const connection = await upsert(
    {
      orgId: org!.id,
      provider: 'plaid',
      providerTenantId: `item-${suffix}`,
      encryptedAccessToken: 'enc:access',
      // Both null: the shape migration 0050 exists for.
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
    },
    dbAdmin,
  );

  return { orgId: org!.id, datasetId: dataset!.id, connectionId: connection.id };
}

function row(over: Partial<NormalizedPlaidRow> = {}): NormalizedPlaidRow {
  return {
    sourceId: 'tx-1',
    date: new Date('2026-11-04T00:00:00Z'),
    amount: '42.50',
    category: 'Food And Drink',
    parentCategory: 'Expenses',
    counterparty: 'Blue Bottle Coffee',
    label: 'SQ *BLUE BOTTLE',
    metadata: { plaid_transaction_id: 'tx-1', plaid_account_id: 'acct-1', pfc_primary: 'FOOD_AND_DRINK' },
    ...over,
  };
}

async function storedRows(orgId: number) {
  return dbAdmin
    .select({
      sourceId: dataRows.sourceId,
      amount: dataRows.amount,
      category: dataRows.category,
      counterparty: dataRows.counterparty,
      metadata: dataRows.metadata,
    })
    .from(dataRows)
    .where(and(eq(dataRows.orgId, orgId), eq(dataRows.sourceType, 'plaid')));
}

describe('writeChanges against real Postgres', () => {
  it('inserts new transactions', async () => {
    const { orgId, datasetId, connectionId } = await seed('insert');

    const result = await writeChanges(
      orgId,
      datasetId,
      connectionId,
      [row({ sourceId: 'tx-a' }), row({ sourceId: 'tx-b' })],
      [],
      'cursor-1',
    );

    expect(result).toEqual({ upserted: 2, removed: 0 });
    expect((await storedRows(orgId)).map((r) => r.sourceId).sort()).toEqual(['tx-a', 'tx-b']);
  });

  // The 0-of-142 bug class. Every sync after the first takes the conflict path,
  // so a column missing from the set clause never updates on an existing row.
  it('updates every column on a re-sync, counterparty included', async () => {
    const { orgId, datasetId, connectionId } = await seed('update');

    await writeChanges(orgId, datasetId, connectionId, [row({ sourceId: 'tx-c' })], [], 'c1');
    await writeChanges(
      orgId,
      datasetId,
      connectionId,
      [
        row({
          sourceId: 'tx-c',
          amount: '99.99',
          category: 'Travel',
          counterparty: 'Delta Air Lines',
          metadata: {
            plaid_transaction_id: 'tx-c',
            plaid_account_id: 'acct-2',
            pfc_primary: 'TRAVEL',
          },
        }),
      ],
      [],
      'c2',
    );

    const [stored] = await storedRows(orgId);
    expect(stored).toMatchObject({
      amount: '99.99',
      category: 'Travel',
      counterparty: 'Delta Air Lines',
      metadata: { plaid_account_id: 'acct-2', pfc_primary: 'TRAVEL' },
    });
  });

  it('deletes a transaction Plaid reported as removed', async () => {
    const { orgId, datasetId, connectionId } = await seed('remove');

    await writeChanges(
      orgId,
      datasetId,
      connectionId,
      [row({ sourceId: 'tx-keep' }), row({ sourceId: 'tx-drop' })],
      [],
      'c1',
    );
    const result = await writeChanges(orgId, datasetId, connectionId, [], ['tx-drop'], 'c2');

    expect(result.removed).toBe(1);
    expect((await storedRows(orgId)).map((r) => r.sourceId)).toEqual(['tx-keep']);
  });

  // Plaid can hand back the same id in both lists across a paginated walk. The
  // write has to win, or a transaction that still exists disappears.
  it('keeps a row that was rewritten and removed in the same batch', async () => {
    const { orgId, datasetId, connectionId } = await seed('conflict');

    const result = await writeChanges(
      orgId,
      datasetId,
      connectionId,
      [row({ sourceId: 'tx-both', amount: '7.00' })],
      ['tx-both'],
      'c1',
    );

    expect(result).toEqual({ upserted: 1, removed: 0 });
    expect((await storedRows(orgId)).map((r) => r.amount)).toEqual(['7.00']);
  });

  it('stores the cursor alongside the rows it accounts for', async () => {
    const { orgId, datasetId, connectionId } = await seed('cursor');

    await writeChanges(orgId, datasetId, connectionId, [row({ sourceId: 'tx-d' })], [], 'cursor-xyz');

    const [conn] = await dbAdmin
      .select({ cursor: integrationConnections.syncCursor })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(conn!.cursor).toBe('cursor-xyz');
  });

  // The reason the cursor write is inside the transaction. A cursor that
  // survived a failed row write would mark transactions as seen that no row
  // exists for, and nothing would ever ask for them again.
  it('leaves the cursor untouched when the row write fails', async () => {
    const { orgId, datasetId, connectionId } = await seed('rollback');
    await writeChanges(orgId, datasetId, connectionId, [row({ sourceId: 'tx-e' })], [], 'good');

    // category is NOT NULL, so this fails inside the transaction after the
    // cursor would otherwise have been set.
    await expect(
      writeChanges(
        orgId,
        datasetId,
        connectionId,
        [row({ sourceId: 'tx-f', category: null as unknown as string })],
        [],
        'should-not-persist',
      ),
    ).rejects.toThrow();

    const [conn] = await dbAdmin
      .select({ cursor: integrationConnections.syncCursor })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(conn!.cursor).toBe('good');
  });

  // Backdated rather than nulled: the column is NOT NULL and defaults to the
  // dataset's creation time, so "never refreshed" is not representable and the
  // only observable is whether the timestamp moved.
  it('touches data_refreshed_at when rows changed', async () => {
    const { orgId, datasetId, connectionId } = await seed('fresh');
    const stale = new Date('2020-01-01T00:00:00Z');
    await dbAdmin.update(datasets).set({ dataRefreshedAt: stale }).where(eq(datasets.id, datasetId));

    await writeChanges(orgId, datasetId, connectionId, [row({ sourceId: 'tx-g' })], [], 'c1');

    const [ds] = await dbAdmin
      .select({ refreshed: datasets.dataRefreshedAt })
      .from(datasets)
      .where(eq(datasets.id, datasetId));
    expect(ds!.refreshed!.getTime()).toBeGreaterThan(stale.getTime());
  });

  // An empty sync is the common case on a quiet day, and reporting it as a
  // refresh would keep a stale dataset looking current (DW-281).
  it('leaves data_refreshed_at alone when nothing changed', async () => {
    const { orgId, datasetId, connectionId } = await seed('noop');
    const stale = new Date('2020-01-01T00:00:00Z');
    await dbAdmin.update(datasets).set({ dataRefreshedAt: stale }).where(eq(datasets.id, datasetId));

    const result = await writeChanges(orgId, datasetId, connectionId, [], [], 'c1');

    expect(result).toEqual({ upserted: 0, removed: 0 });
    const [ds] = await dbAdmin
      .select({ refreshed: datasets.dataRefreshedAt })
      .from(datasets)
      .where(eq(datasets.id, datasetId));
    expect(ds!.refreshed!.getTime()).toBe(stale.getTime());
  });

  // Scoped by dataset, which is the predicate doing the work: a dataset belongs
  // to one org, so the org_id in the delete is redundant defense-in-depth rather
  // than the thing keeping orgs apart. Removing org_id from the query leaves
  // this green, which is why the name says dataset.
  it('scopes the delete to this org\'s own dataset', async () => {
    const mine = await seed('mine');
    const theirs = await seed('theirs');
    await writeChanges(mine.orgId, mine.datasetId, mine.connectionId, [row({ sourceId: 'shared-id' })], [], 'c1');
    await writeChanges(theirs.orgId, theirs.datasetId, theirs.connectionId, [row({ sourceId: 'shared-id' })], [], 'c1');

    await writeChanges(mine.orgId, mine.datasetId, mine.connectionId, [], ['shared-id'], 'c2');

    expect(await storedRows(mine.orgId)).toHaveLength(0);
    expect(await storedRows(theirs.orgId)).toHaveLength(1);
  });
});
