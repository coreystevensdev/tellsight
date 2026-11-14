import postgres, { type Sql } from 'postgres';
import { DATABASE_ADMIN_URL } from './config';
import { mintToken } from './tokens';

// seed org created by apps/api/src/db/seed.ts
export const SEED_ORG_ID = 1;

export const TEST_USER = {
  email: 'e2e-test@example.com',
  name: 'E2E Test User',
  googleId: 'e2e-test-google-id',
  role: 'owner' as const,
  isAdmin: true,
} as const;

export const FREE_TIER_USER = {
  email: 'e2e-free@example.com',
  name: 'E2E Free User',
  googleId: 'e2e-free-google-id',
  role: 'member' as const,
  isAdmin: false,
} as const;

let _sql: Sql | null = null;

function getConnection(): Sql {
  if (!_sql) _sql = postgres(DATABASE_ADMIN_URL, { max: 2 });
  return _sql;
}

export async function cleanupFixtureConnection(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

/**
 * Inserts a test user + org membership, returning the userId.
 * Upserts on email to survive multiple test runs.
 */
export async function ensureTestUser(
  user: typeof TEST_USER | typeof FREE_TIER_USER,
  orgId = SEED_ORG_ID,
): Promise<{ userId: number; orgId: number }> {
  const sql = getConnection();

  const [row] = await sql`
    INSERT INTO users (email, name, google_id, is_platform_admin)
    VALUES (${user.email}, ${user.name}, ${user.googleId}, ${user.isAdmin})
    ON CONFLICT (email) DO UPDATE SET
      is_platform_admin = EXCLUDED.is_platform_admin,
      name = EXCLUDED.name
    RETURNING id
  `;

  if (!row) throw new Error(`ensureTestUser: no row returned for ${user.email}`);
  const userId = row.id as number;

  await sql`
    INSERT INTO user_orgs (user_id, org_id, role)
    VALUES (${userId}, ${orgId}, ${user.role})
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role
  `;

  return { userId, orgId };
}

/**
 * The seed dataset's id. getDatasetListWithCounts filters isSeedData = false,
 * because /datasets/manage is a list of user uploads, so the seed dataset is
 * invisible through the API even though it is the only one a fresh CI org has.
 */
/**
 * A throwaway org for tests that write real datasets. persistUpload deletes an
 * org's seed data as part of the same transaction, so running an upload against
 * SEED_ORG_ID destroys the fixture every later test depends on.
 */
/**
 * An alert rule to hang a mute token off. The mute routes are reached from an
 * alert email, so the rule has to exist for the confirm to resolve to anything.
 */
/** The org name the share fixture writes into its snapshot. The share page
 *  renders the snapshot rather than the live org, so asserting this string
 *  proves the token resolved to this row and not to an error card. */
export const SHARE_FIXTURE_ORG = 'E2E Share Fixture Org';

/** A share needs a dataset to point at, and the seed dataset is not dependable:
 *  persistUpload deletes an org's seed data, so a local database that has run
 *  uploads has none even though a fresh CI one does. Reuses any dataset the org
 *  already has and creates one only when there is nothing at all. */
async function ensureSomeDataset(orgId: number, uploadedBy: number): Promise<number> {
  const sql = getConnection();

  const [existing] = await sql`
    SELECT id FROM datasets WHERE org_id = ${orgId} ORDER BY id LIMIT 1
  `;
  if (existing) return existing.id as number;

  const [row] = await sql`
    INSERT INTO datasets (org_id, name, source_type, is_seed_data, uploaded_by)
    VALUES (${orgId}, 'E2E share fixture dataset', 'csv', false, ${uploadedBy})
    RETURNING id
  `;
  if (!row) throw new Error('ensureSomeDataset: no row returned');
  return row.id as number;
}

export async function createShareToken(orgId: number, createdBy: number): Promise<string> {
  const sql = getConnection();
  const datasetId = await ensureSomeDataset(orgId, createdBy);
  const { raw, hash } = mintToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO shares (org_id, dataset_id, token_hash, insight_snapshot, created_by, expires_at)
    VALUES (${orgId}, ${datasetId}, ${hash}, ${sql.json({
      orgName: SHARE_FIXTURE_ORG,
      dateRange: 'Jan 2026, Mar 2026',
      aiSummaryContent: 'Revenue held steady while costs rose slightly over the quarter.',
      chartConfig: {},
    })}, ${createdBy}, ${expiresAt})
  `;
  return raw;
}

export async function createInviteToken(orgId: number, createdBy: number): Promise<string> {
  const sql = getConnection();
  const { raw, hash } = mintToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO org_invites (org_id, token_hash, created_by, expires_at)
    VALUES (${orgId}, ${hash}, ${createdBy}, ${expiresAt})
  `;
  return raw;
}

export async function createPasswordResetToken(userId: number): Promise<string> {
  const sql = getConnection();
  const { raw, hash } = mintToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await sql`
    INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
    VALUES (${hash}, ${userId}, ${expiresAt})
  `;
  return raw;
}

export async function ensureAlertRule(
  orgId: number,
  createdByUserId: number,
  kind = 'runway_runs_short',
): Promise<number> {
  const sql = getConnection();

  const [existing] = await sql`
    SELECT id FROM alert_rules
    WHERE org_id = ${orgId} AND kind = ${kind} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing) return existing.id as number;

  const [row] = await sql`
    INSERT INTO alert_rules (org_id, created_by_user_id, kind, threshold, enabled)
    VALUES (${orgId}, ${createdByUserId}, ${kind}, ${sql.json({ months: 3 })}, true)
    RETURNING id
  `;
  if (!row) throw new Error('ensureAlertRule: no row returned');
  return row.id as number;
}

export async function ensureIsolatedOrg(
  slug: string,
  user: typeof TEST_USER | typeof FREE_TIER_USER = TEST_USER,
): Promise<{ userId: number; orgId: number }> {
  const sql = getConnection();

  const [org] = await sql`
    INSERT INTO orgs (name, slug)
    VALUES (${`e2e ${slug}`}, ${`e2e-${slug}`})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!org) throw new Error(`ensureIsolatedOrg: no row returned for ${slug}`);
  const orgId = org.id as number;

  const { userId } = await ensureTestUser(user, orgId);
  return { userId, orgId };
}

export async function getSeedDatasetId(orgId: number = SEED_ORG_ID): Promise<number | null> {
  const sql = getConnection();
  const [row] = await sql`
    SELECT id FROM datasets
    WHERE org_id = ${orgId} AND is_seed_data = true
    ORDER BY id
    LIMIT 1
  `;
  return row ? (row.id as number) : null;
}

/** Minimal valid CSV for upload tests */
export const SAMPLE_CSV = `date,amount,category
2025-01-15,1200.00,Revenue
2025-02-15,1350.00,Revenue
2025-03-15,800.00,Marketing
`;
