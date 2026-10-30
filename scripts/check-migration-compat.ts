// Fails when a migration does something the previous release cannot survive.
//
// The deploy rolls back by re-pinning the previous image, but it never rolls
// back the database, and migrations run at container start. So after a rollback
// the old code runs against the new schema. Dropping a column the old code still
// selects turns a rollback into a second outage, which is the worst possible
// moment to discover it.
//
// The rule is expand then contract, across two releases: add the new column and
// write to both, ship it, and only drop the old one once no deployed version
// reads it. That second step is what the acknowledgement list below is for.
//
// Migration files are content-hashed in __drizzle_migrations once applied, so
// annotating an old file to silence this check would be a worse idea than it
// looks. The list lives here instead.
//
// The SQL patterns below only see the relational schema, and most of this app's
// structure is not there. key_stats, milestones, transparency_metadata and
// threshold are jsonb, and the code dereferences named keys out of them on
// every read: isComputedStat and hasValidDiscriminatorFields both do it to
// key_stats. Removing a key from one of those documents breaks a rolled-back
// reader exactly the way DROP COLUMN does, but it is written as an UPDATE and
// matches no pattern here. That was DW-221, and it mattered because the
// contract half of the year-over-year rename is precisely that migration.
//
// So any migration that writes to a jsonb column is flagged and needs an
// acknowledgement. Whether a given write is additive or destructive is not
// decidable from the SQL without modelling jsonb semantics, so the check does
// not try: it asks for a human sentence instead.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyMigration,
  extractJsonbColumns,
  findMigrationFindings,
} from './safety-gates/migration-compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '../apps/api/drizzle/migrations');
const SCHEMA = join(here, '../apps/api/src/db/schema.ts');

// Read from the schema rather than restating it, or the list silently stops
// matching the tables the moment somebody adds a jsonb column.
const JSONB_COLUMNS = extractJsonbColumns(readFileSync(SCHEMA, 'utf8'));

// Reviewed and accepted. Each entry needs a reason that says why the previous
// release did not read the thing being removed.
const ACKNOWLEDGED = new Map<string, string>([
  [
    '0022_drop-user-orgs-digest-opt-in.sql',
    'digest_opt_in was superseded by the digest_preferences table in Epic 9 and no deployed version read it',
  ],
  [
    '0032_add-digest-history-milestones-catalog-check.sql',
    'adds a catalog key to each milestones entry and removes nothing, so a rolled-back reader still finds every key it dereferences',
  ],
  [
    '0044_drop-yoy-legacy-keys.sql',
    'the contract half of the year-over-year rename: removes currentYear and priorYear from key_stats entries that already carry currentRevenue. The reader changed in 1108052 and the last six deploys all read the new keys, so the first image that still needs the old pair is seven deploys back; a rollback that far degrades rather than breaks, since isComputedStat drops an entry with a missing discriminator instead of throwing',
  ],
  [
    '0043_add-yoy-revenue-keys.sql',
    'the expand half of the year-over-year rename: adds currentRevenue and priorRevenue to key_stats entries and leaves currentYear and priorYear in place, which is what lets the previous release keep reading them',
  ],
]);

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
const migrations = Object.fromEntries(
  migrationFiles.map((file) => [file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8')]),
);

for (const file of migrationFiles) {
  const hits = classifyMigration(migrations[file]!, JSONB_COLUMNS);
  if (hits.length > 0 && ACKNOWLEDGED.has(file)) {
    console.info(`OK (acknowledged): ${file} [${hits.join(', ')}]`);
  }
}

const findings = findMigrationFindings(migrations, JSONB_COLUMNS, new Set(ACKNOWLEDGED.keys()));

if (findings.length > 0) {
  console.error('\nBackward-incompatible migration(s) found:\n');
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.hits.join(', ')}`);
  console.error(`
A rollback re-pins the previous image but leaves the database where it is, so
the previous release will run against this schema.

Either split it across two releases (add the new shape, ship, drop the old one
next time), or, if no deployed version reads what is being removed, add the file
to ACKNOWLEDGED in scripts/check-migration-compat.ts with the reason.
`);
  process.exit(1);
}

console.info(`PASS: ${migrationFiles.length} migrations checked, none break a rollback`);
