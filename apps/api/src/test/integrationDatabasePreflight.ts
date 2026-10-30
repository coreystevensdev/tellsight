import postgres from 'postgres';

interface DatabaseProbeResult {
  currentUser: string;
  databaseName: string;
  schemaPresent: boolean;
}

export type DatabaseProbe = (url: string) => Promise<DatabaseProbeResult>;

function requiredUrl(name: 'DATABASE_URL' | 'DATABASE_ADMIN_URL', value: string | undefined) {
  if (!value) {
    throw new Error(`${name} is required for the RLS integration suite`);
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} is not a valid database URL`);
  }

  return value;
}

function describeTarget(url: string): string {
  const parsed = new URL(url);
  const port = parsed.port || '5432';
  return `${parsed.hostname}:${port}${parsed.pathname}`;
}

export const probeDatabase: DatabaseProbe = async (url) => {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
    onnotice: () => {},
  });

  try {
    const [row] = await sql<DatabaseProbeResult[]>`
      SELECT
        current_user AS "currentUser",
        current_database() AS "databaseName",
        to_regclass('public.orgs') IS NOT NULL AS "schemaPresent"
    `;

    if (!row) throw new Error('database probe returned no rows');
    return row;
  } finally {
    await sql.end({ timeout: 1 });
  }
};

async function probeTarget(
  label: 'app' | 'admin',
  url: string,
  probe: DatabaseProbe,
): Promise<DatabaseProbeResult> {
  try {
    return await probe(url);
  } catch {
    throw new Error(
      `Cannot connect to the ${label} integration database at ${describeTarget(url)}. ` +
        'Start the local database or correct the database URLs before running the suite.',
    );
  }
}

export async function checkIntegrationDatabase(
  environment: NodeJS.ProcessEnv = process.env,
  probe: DatabaseProbe = probeDatabase,
): Promise<void> {
  const appUrl = requiredUrl('DATABASE_URL', environment.DATABASE_URL);
  const adminUrl = requiredUrl('DATABASE_ADMIN_URL', environment.DATABASE_ADMIN_URL);

  const [app, admin] = await Promise.all([
    probeTarget('app', appUrl, probe),
    probeTarget('admin', adminUrl, probe),
  ]);

  if (app.databaseName !== admin.databaseName) {
    throw new Error('DATABASE_URL and DATABASE_ADMIN_URL must point to the same database');
  }
  if (app.currentUser === admin.currentUser) {
    throw new Error('DATABASE_URL and DATABASE_ADMIN_URL must use different database roles');
  }
  if (!app.schemaPresent || !admin.schemaPresent) {
    throw new Error('The integration database schema is missing; run the migrations first');
  }
}
