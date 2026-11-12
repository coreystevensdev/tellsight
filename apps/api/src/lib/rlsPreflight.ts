import { sql } from 'drizzle-orm';

import { db } from './db.js';
import { logger } from './logger.js';

// A type alias, not an interface: db.execute<T> constrains T to
// Record<string, unknown>, and only an alias gets the implicit index signature.
export type RlsEnforcement = {
  role: string;
  isSuper: boolean;
  canBypassRls: boolean;
  ownedUnforcedTables: number;
};

export type RlsProbe = () => Promise<RlsEnforcement>;

// Three ways a role escapes its own policies. The third is the one this
// deployment actually leans on: migrations run as app_admin, so app_admin owns
// every table, and no table sets FORCE. Point DATABASE_URL at the admin role
// and every policy becomes decoration without a single query raising anything.
const probeRlsEnforcement: RlsProbe = async () => {
  const rows = await db.execute<RlsEnforcement>(sql`
    SELECT
      current_user AS "role",
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS "isSuper",
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS "canBypassRls",
      (
        SELECT count(*)::int
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity
          AND pg_get_userbyid(c.relowner) = current_user
      ) AS "ownedUnforcedTables"
  `);

  const row = rows[0];
  if (!row) throw new Error('RLS preflight returned no rows');
  return row;
};

function bypassReasons({ isSuper, canBypassRls, ownedUnforcedTables }: RlsEnforcement): string[] {
  const reasons: string[] = [];
  if (isSuper) reasons.push('it is a superuser');
  if (canBypassRls) reasons.push('it has BYPASSRLS');
  if (ownedUnforcedTables > 0) {
    reasons.push(`it owns ${ownedUnforcedTables} table(s) with RLS enabled but not forced`);
  }
  return reasons;
}

/** Every tenant boundary in the app is a database policy, and all of them stop
 *  applying if DATABASE_URL names the migration role. infra/README.md warns a
 *  human about it and the integration suite checks it; production did not. */
export async function assertRlsEnforced(
  nodeEnv: string,
  probe: RlsProbe = probeRlsEnforcement,
): Promise<void> {
  let enforcement: RlsEnforcement;

  try {
    enforcement = await probe();
  } catch (err) {
    const message = 'Could not verify that row-level security applies to the application role';
    if (nodeEnv === 'production') throw new Error(message, { cause: err });
    logger.warn({ err }, message);
    return;
  }

  const reasons = bypassReasons(enforcement);
  if (reasons.length === 0) {
    logger.info({ role: enforcement.role }, 'Row-level security applies to the application role');
    return;
  }

  const message =
    `Row-level security does not apply to "${enforcement.role}": ${reasons.join(', ')}. ` +
    'DATABASE_URL must point at the restricted application role, not the migration role.';

  if (nodeEnv === 'production') throw new Error(message);
  logger.warn({ role: enforcement.role, reasons }, message);
}
