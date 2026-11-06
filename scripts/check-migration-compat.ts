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
// The relational patterns only see the schema's shape, and most of what a reader
// depends on is not there. key_stats, milestones, transparency_metadata and
// threshold are jsonb and the code dereferences named keys out of them on every
// read. source_id is a varchar the QuickBooks normalizer builds keys from. In
// both cases a rewrite of the values strands a rolled-back reader exactly the way
// DROP COLUMN does, while being written as an UPDATE. Those were DW-221 and
// DW-239, found eight months apart with the same shape.
//
// Two attempts to catch them by naming the column both leaked, and the leaks are
// the reason this no longer tries. An assignment hides behind a subquery's FROM,
// behind a stop word in a trailing comment, behind a semicolon inside a string
// literal, or behind Postgres's SET (a, b) = (...) form. Worse, when the first
// assignment happened to be a watched column the gate named that one and said
// nothing about the real write, so a reviewer acknowledged the wrong column. And
// a watch list read out of the Drizzle schema missed users.email, users.google_id
// and orgs.slug, because those are unique by column-level .unique() rather than
// by a uniqueIndex() declaration, which is to say it missed the login key.
//
// So the check is now coarse on purpose: any migration that rewrites existing
// rows at all is flagged and needs a sentence. Whether a given write is additive
// or destructive is not decidable from SQL without modelling the application, and
// this gate has never pretended to do that. Measured when it changed: 4 of 46
// migrations write row data, and all four were already acknowledged, so the
// coarse rule costs one sentence per data migration and nothing else.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Acknowledgement,
  classifyMigration,
  findMigrationFindings,
} from './safety-gates/migration-compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '../apps/api/drizzle/migrations');
const JOURNAL = join(MIGRATIONS_DIR, 'meta/_journal.json');

// Reviewed and accepted. `hits` is what each reason was written against, so
// adding an operation to an acknowledged file flags it again instead of
// inheriting the old sentence.
const ACKNOWLEDGED = new Map<string, Acknowledgement>([
  [
    '0022_drop-user-orgs-digest-opt-in.sql',
    {
      hits: ['DROP COLUMN'],
      reason:
        'digest_opt_in was superseded by the digest_preferences table in Epic 9 and no deployed version read it',
    },
  ],
  [
    '0032_add-digest-history-milestones-catalog-check.sql',
    {
      hits: ['DATA WRITE'],
      reason:
        'adds a catalog key to each milestones entry and removes nothing, so a rolled-back reader still finds every key it dereferences',
    },
  ],
  [
    '0043_add-yoy-revenue-keys.sql',
    {
      hits: ['DATA WRITE'],
      reason:
        'the expand half of the year-over-year rename: adds currentRevenue and priorRevenue to key_stats entries and leaves currentYear and priorYear in place, which is what lets the previous release keep reading them',
    },
  ],
  [
    '0044_drop-yoy-legacy-keys.sql',
    {
      hits: ['DATA WRITE'],
      reason:
        'the contract half of the year-over-year rename: removes currentYear and priorYear from key_stats entries that already carry currentRevenue. The reader changed in 1108052 and the last six deploys all read the new keys, so the first image that still needs the old pair is seven deploys back; a rollback that far degrades rather than breaks, since isComputedStat drops an entry with a missing discriminator instead of throwing',
    },
  ],
  [
    '0045_add-entity-type-to-quickbooks-source-id.sql',
    {
      hits: ['DATA WRITE'],
      reason:
        'rewrites every quickbooks source_id from "<id>-<lineId>" to "<txnType>-<id>-<lineId>", and writes no other column. One image back, a rolled-back normalizer builds the old key and matches no row, but the writer reconciliation deletes rows whose (qb_id, txnType) match a fetched transaction and whose source_id is not among the ones just produced, which is precisely the rewritten row, so it converges on one row per line rather than doubling. Two images back there is no reconciliation: it landed in 66e8cbb on 2026-11-05, about eleven hours before the normalizer change, so a rollback that deep does double every re-fetched quickbooks transaction until a human intervenes. Worth saying plainly that the one-image safety is incidental, bought by an unrelated change that happened to land first rather than by anything in the migration',
    },
  ],
]);

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

// A PASS has to mean something was checked. `PASS: 0 migrations` read exactly
// like a real pass, and endsWith('.sql') is case sensitive and readdirSync does
// not recurse, so a file drizzle would apply could sit outside this list.
const journalTags: string[] = JSON.parse(readFileSync(JOURNAL, 'utf8')).entries.map(
  (entry: { tag: string }) => `${entry.tag}.sql`,
);
const unchecked = journalTags.filter((tag) => !sqlFiles.includes(tag));
if (sqlFiles.length === 0 || unchecked.length > 0) {
  console.error(
    sqlFiles.length === 0
      ? `\nNo .sql files found in ${MIGRATIONS_DIR}, so nothing was checked.\n`
      : `\nMigrations in _journal.json with no matching .sql file this check could read:\n  ${unchecked.join('\n  ')}\n`,
  );
  process.exit(1);
}

const migrations = Object.fromEntries(
  sqlFiles.map((file) => [file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8')]),
);

for (const file of sqlFiles) {
  const hits = classifyMigration(migrations[file]!);
  if (hits.length > 0 && ACKNOWLEDGED.has(file)) {
    console.info(`OK (acknowledged): ${file} [${hits.join(', ')}]`);
  }
}

const findings = findMigrationFindings(migrations, ACKNOWLEDGED);

if (findings.length > 0) {
  console.error('\nBackward-incompatible migration(s) found:\n');
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.hits.join(', ')}`);
  console.error(`
A rollback re-pins the previous image but leaves the database where it is, so
the previous release will run against this schema.

Either split it across two releases (add the new shape, ship, drop the old one
next time), or, if no deployed version reads what is being removed, add the file
to ACKNOWLEDGED in scripts/check-migration-compat.ts with its hits and a reason.

A DATA WRITE means the migration rewrites existing rows. Say which columns it
writes, which deployed version still reads the old values, and what happens to
the rows it will not match. An already-acknowledged file reappears here when its
operations change, which means the sentence needs rewriting rather than moving.
`);
  process.exit(1);
}

console.info(`PASS: ${sqlFiles.length} migrations checked, none break a rollback`);
