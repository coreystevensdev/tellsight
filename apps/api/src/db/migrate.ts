// Standalone migration script, runs before the Express app boots (via Docker entrypoint).
// Exceptions from CLAUDE.md rules:
//   - process.env: config.ts validates ALL env vars (REDIS_URL, CLAUDE_API_KEY, etc.)
//     which aren't available in the migration context. Direct access is intentional.
//   - console.log: Pino is an app-level logger tied to the Express lifecycle.
//     Migration scripts use console for operational output before the app starts.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_URL) is required for migrations');
  process.exit(1);
}

const migrationClient = postgres(dbUrl, { max: 1 });

// Advisory lock ID, any constant int64 works. Defense-in-depth against concurrent
// boots racing the migrator when a platform (Railway, etc.) restarts or scales the
// API container. Drizzle's journal catches double-application, but the lock turns
// a race into a queue: the second boot waits, then finds nothing to do.
const MIGRATION_LOCK_ID = 42;

async function runMigrations() {
  const db = drizzle(migrationClient);

  console.info('Acquiring migration advisory lock...');
  await migrationClient`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  try {
    console.info('Running database migrations...');
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    console.info('Migrations completed successfully');
  } finally {
    await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }

  await migrationClient.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
