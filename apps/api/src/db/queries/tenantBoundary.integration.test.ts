import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { orgs, users } from '../schema.js';
import { createDataset, getDatasetById, getDatasetsByOrg } from './datasets.js';
import { insertBatch, getRowsByDataset, getRowCount } from './dataRows.js';
import { upsert, getByOrgAndProvider } from './integrationConnections.js';
import { recordEvent, getEventsByOrg } from './analyticsEvents.js';
import { record as recordAudit, query as queryAudit } from './auditLogs.js';
import { dbAdmin } from '../../lib/db.js';

// Every helper here takes an orgId and filters on it. That predicate is the
// tenant boundary, and the unit tests mock at db.query.<table>.findFirst or
// .findMany and assert only that a query ran, so deleting it leaves them green
// while one org reads another's datasets, rows, OAuth connections, analytics and
// audit trail.
//
// Two orgs are seeded with the same shapes of data, and every case asks org A's
// question and requires that none of org B's rows come back. Seeding both is the
// point: with the predicate gone the query returns whatever is there, so there
// has to be something wrong for it to return.
//
// Runs with dbAdmin, which bypasses RLS. That is deliberate. RLS is a second
// layer tested in rls.integration.test.ts; this asks whether the query itself
// filters, which is what the mocked tests claimed to check.

const suffix = `tenant-${process.pid}`;
const createdOrgs: number[] = [];
const createdUsers: number[] = [];

let orgA: number;
let orgB: number;
let datasetA: number;
let datasetB: number;

async function seedOrg(label: string) {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `${label} ${suffix}`, slug: `${label}-${suffix}` })
    .returning();
  createdOrgs.push(org!.id);

  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `${label}-${suffix}@example.com`, name: label })
    .returning();
  createdUsers.push(user!.id);

  const dataset = await createDataset(org!.id, { name: `${label}.csv` }, dbAdmin);

  await insertBatch(
    org!.id,
    dataset!.id,
    [{ category: `${label}-category`, date: new Date('2026-01-15'), amount: '100.00' }],
    dbAdmin,
  );

  await upsert(
    {
      orgId: org!.id,
      provider: 'quickbooks',
      providerTenantId: `realm-${label}`,
      encryptedRefreshToken: `refresh-${label}`,
      encryptedAccessToken: `access-${label}`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
    dbAdmin,
  );

  await recordEvent(org!.id, user!.id, ANALYTICS_EVENTS.DASHBOARD_VIEWED, { label }, dbAdmin);
  await recordAudit({ orgId: org!.id, userId: user!.id, action: `audit.${label}` });

  return { orgId: org!.id, userId: user!.id, datasetId: dataset!.id };
}

beforeAll(async () => {
  const a = await seedOrg('org-a');
  const b = await seedOrg('org-b');
  orgA = a.orgId;
  datasetA = a.datasetId;
  orgB = b.orgId;
  datasetB = b.datasetId;
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('datasets stay inside their org', () => {
  it('finds its own dataset by id', async () => {
    const found = await getDatasetById(orgA, datasetA, dbAdmin);
    expect(found).toBeDefined();
    expect(found!.orgId).toBe(orgA);
  });

  // Drop eq(datasets.orgId) and this returns org B's dataset to org A.
  it('does not find another org dataset by id', async () => {
    expect(await getDatasetById(orgA, datasetB, dbAdmin)).toBeUndefined();
  });

  it('lists only its own datasets', async () => {
    const list = await getDatasetsByOrg(orgA, dbAdmin);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((d) => d.orgId === orgA)).toBe(true);
  });
});

describe('data rows stay inside their org', () => {
  it('reads only its own rows', async () => {
    const rows = await getRowsByDataset(orgA, datasetA, dbAdmin);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orgId === orgA)).toBe(true);
  });

  // orgA paired with orgB's dataset. Drop either predicate and rows come back.
  it('reads nothing for another org dataset', async () => {
    expect(await getRowsByDataset(orgA, datasetB, dbAdmin)).toHaveLength(0);
    expect(await getRowCount(orgA, datasetB, dbAdmin)).toBe(0);
  });
});

describe('integration connections stay inside their org', () => {
  it('finds its own connection', async () => {
    const conn = await getByOrgAndProvider(orgA, 'quickbooks', dbAdmin);
    expect(conn).not.toBeNull();
    expect(conn!.orgId).toBe(orgA);
    expect(conn!.providerTenantId).toBe('realm-org-a');
  });

  // Both orgs have a quickbooks connection, so dropping eq(orgId) hands org A
  // whichever row comes first, and these rows hold OAuth tokens.
  it('never returns another org connection for the same provider', async () => {
    const conn = await getByOrgAndProvider(orgB, 'quickbooks', dbAdmin);
    expect(conn!.orgId).toBe(orgB);
    expect(conn!.providerTenantId).toBe('realm-org-b');
  });
});

describe('analytics and audit stay inside their org', () => {
  it('returns only its own analytics events', async () => {
    const events = await getEventsByOrg(orgA, { limit: 100 }, dbAdmin);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.orgId === orgA)).toBe(true);
  });

  it('returns only its own audit entries when filtered by org', async () => {
    const rows = await queryAudit({ orgId: orgA, limit: 100 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === 'audit.org-a')).toBe(true);
  });
});
