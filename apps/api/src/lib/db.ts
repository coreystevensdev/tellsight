import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config.js';
import * as schema from '../db/schema.js';

// prepare: false is not a preference, it is the mitigation postgres 4.0.0 needs.
// Its prepared-statement cache keeps the query that prepared each entry, values
// and rows included, up to 1,000 statements per connection. Upstream measures
// about 1.1 GB at 10 connections with 50-row results, and this runs on a
// t3.micro with roughly 916 MB shared with web, redis and caddy, across 35
// connections between the two pools below. The fix is in the unreleased 4.1.0;
// remove this and restore prepared statements when that ships.
export const queryClient = postgres(env.DATABASE_URL, {
  max: 25,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
  connection: { timezone: 'UTC' },
});

export const adminClient = postgres(env.DATABASE_ADMIN_URL, {
  max: 10,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
  connection: { timezone: 'UTC' },
});

export const db = drizzle(queryClient, { schema });
export const dbAdmin = drizzle(adminClient, { schema });

/** Transaction client type, use for query functions that optionally accept a tx */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// SELECT 1 only proved the connection. It passed against a database with no
// tables in it at all, which is how a dev container once reported ready and then
// 500ed on every request.
//
// Deliberately a short, stable list rather than every table. This gates paging
// and deploy rollback, so a false negative is expensive, and renaming one of
// these would break the check. check-migration-compat.ts fails on RENAME TO,
// which is the second net.
const REQUIRED_TABLES = ['users', 'orgs', 'user_orgs', 'datasets', 'data_rows'] as const;

export type DbHealth = {
  status: 'ok' | 'error';
  latencyMs: number;
  reason?: 'connection' | 'schema';
  missing?: string[];
};

export async function checkDatabaseHealth(): Promise<DbHealth> {
  const start = Date.now();
  try {
    // Static SQL, no interpolation. to_regclass needs no table privileges, so
    // this works as the restricted app_user without widening its grants.
    const rows = await db.execute<Record<string, boolean>>(sql`
      SELECT
        to_regclass('public.users')     IS NOT NULL AS users,
        to_regclass('public.orgs')      IS NOT NULL AS orgs,
        to_regclass('public.user_orgs') IS NOT NULL AS user_orgs,
        to_regclass('public.datasets')  IS NOT NULL AS datasets,
        to_regclass('public.data_rows') IS NOT NULL AS data_rows
    `);

    const present = rows[0];
    const missing = REQUIRED_TABLES.filter((table) => present?.[table] !== true);

    if (missing.length > 0) {
      return { status: 'error', reason: 'schema', missing, latencyMs: Date.now() - start };
    }

    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', reason: 'connection', latencyMs: Date.now() - start };
  }
}
