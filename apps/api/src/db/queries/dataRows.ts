import { eq, and, between, inArray, asc, count, sql } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { dataRows } from '../schema.js';
import type { MonthlyBucketMap } from '../../services/curation/computation.js';

const BATCH_SIZE = 1_000;

export async function insertBatch(
  orgId: number,
  datasetId: number,
  rows: Array<{
    sourceType?: 'csv';
    category: string;
    parentCategory?: string | null;
    date: Date;
    amount: string;
    label?: string | null;
    metadata?: Record<string, unknown> | null;
  }>,
  client: typeof db | DbTransaction = db,
) {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = chunk.map((row) => ({ orgId, datasetId, ...row }));
    await client.insert(dataRows).values(values);
  }
}

export async function getByDateRange(
  orgId: number,
  startDate: Date,
  endDate: Date,
  datasetIds?: number[],
) {
  const conditions = [
    eq(dataRows.orgId, orgId),
    between(dataRows.date, startDate, endDate),
  ];
  if (datasetIds?.length) {
    conditions.push(inArray(dataRows.datasetId, datasetIds));
  }

  return db.query.dataRows.findMany({
    where: and(...conditions),
    orderBy: asc(dataRows.date),
  });
}

export async function getByCategory(
  orgId: number,
  category: string,
  datasetIds?: number[],
) {
  const conditions = [
    eq(dataRows.orgId, orgId),
    eq(dataRows.category, category),
  ];
  if (datasetIds?.length) {
    conditions.push(inArray(dataRows.datasetId, datasetIds));
  }

  return db.query.dataRows.findMany({
    where: and(...conditions),
    orderBy: asc(dataRows.date),
  });
}

export async function getRowCount(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
): Promise<number> {
  const [row] = await client
    .select({ value: count() })
    .from(dataRows)
    .where(and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)));
  return row?.value ?? 0;
}

export async function getRowsByDataset(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.dataRows.findMany({
    where: and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)),
    orderBy: asc(dataRows.date),
  });
}

/**
 * SQL-aggregated monthly revenue/expense buckets for a dataset. Returns the
 * same shape `bucketRowsByMonth` produces from raw rows, but lets Postgres do
 * the bucketing, a 50k-row dataset collapses to ~12-60 result rows in the
 * database, so the API never holds the full row set in memory.
 *
 * Used by the /cash-forecast endpoint where we need aggregates only.
 * The curation pipeline (AI summary generation) still fetches rows because
 * it needs them for other stats (anomaly detection, trend regression, etc.).
 */
export async function getMonthlyBucketsByDataset(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
): Promise<MonthlyBucketMap> {
  const rows = await client
    .select({
      bucket: sql<string>`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`.as('bucket'),
      parentCategory: dataRows.parentCategory,
      total: sql<string>`sum(${dataRows.amount})`.as('total'),
    })
    .from(dataRows)
    .where(and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)))
    .groupBy(
      sql`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`,
      dataRows.parentCategory,
    );

  const buckets: MonthlyBucketMap = new Map();
  for (const r of rows) {
    const amt = parseFloat(r.total);
    if (!Number.isFinite(amt)) continue;
    const bucket = buckets.get(r.bucket) ?? { revenue: 0, expenses: 0 };
    if (r.parentCategory === 'Income') {
      bucket.revenue += amt;
    } else if (r.parentCategory === 'Expenses') {
      bucket.expenses += amt;
    }
    buckets.set(r.bucket, bucket);
  }
  return buckets;
}
