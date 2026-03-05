import { eq, and, between, inArray, asc } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { dataRows } from '../schema.js';

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

export async function getRowsByDataset(orgId: number, datasetId: number) {
  return db.query.dataRows.findMany({
    where: and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId)),
    orderBy: asc(dataRows.date),
  });
}
