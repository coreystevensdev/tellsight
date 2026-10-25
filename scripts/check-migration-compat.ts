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

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '../apps/api/drizzle/migrations');
const SCHEMA = join(here, '../apps/api/src/db/schema.ts');

// Read from the schema rather than restating it, or the list silently stops
// matching the tables the moment somebody adds a jsonb column.
function jsonbColumns(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const explicit = [...src.matchAll(/jsonb\('([a-z_]+)'\)/g)].map((m) => m[1]!);
  // drizzle infers the column name from the property when jsonb() is bare
  const inferred = [...src.matchAll(/(\w+)\s*:\s*jsonb\(\)/g)].map((m) => m[1]!);
  return [...new Set([...explicit, ...inferred])];
}

const JSONB_COLUMNS = jsonbColumns();

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { label: 'RENAME COLUMN', re: /\bRENAME\s+COLUMN\b/i },
  { label: 'RENAME TO', re: /\bRENAME\s+TO\b/i },
  { label: 'SET DATA TYPE', re: /\bSET\s+DATA\s+TYPE\b/i },
  // Adding NOT NULL to a column the old code still inserts without is the same
  // class of break, just louder: every old-code insert fails outright.
  { label: 'SET NOT NULL', re: /\bSET\s+NOT\s+NULL\b/i },
];

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
    '0043_add-yoy-revenue-keys.sql',
    'the expand half of the year-over-year rename: adds currentRevenue and priorRevenue to key_stats entries and leaves currentYear and priorYear in place, which is what lets the previous release keep reading them',
  ],
]);

const findings: string[] = [];

for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

  // Strip line comments first, so a rationale that names DROP COLUMN in prose
  // does not trip the check that the rationale exists to explain.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  const hits = PATTERNS.filter((p) => p.re.test(statements)).map((p) => p.label);

  // `SET "col" =` and not the bare word UPDATE: a foreign key clause carries
  // ON UPDATE no action, which matched three migrations that touch no jsonb at
  // all when this was first drafted.
  const written = JSONB_COLUMNS.filter((c) =>
    new RegExp(`\\bSET\\s+"?${c}"?\\s*=`, 'i').test(statements),
  );
  if (written.length > 0) hits.push(`JSONB WRITE (${written.join(', ')})`);

  if (hits.length === 0) continue;

  if (ACKNOWLEDGED.has(file)) {
    console.info(`OK (acknowledged): ${file} [${hits.join(', ')}]`);
    continue;
  }

  findings.push(`${file}: ${hits.join(', ')}`);
}

if (findings.length > 0) {
  console.error('\nBackward-incompatible migration(s) found:\n');
  for (const f of findings) console.error(`  ${f}`);
  console.error(`
A rollback re-pins the previous image but leaves the database where it is, so
the previous release will run against this schema.

Either split it across two releases (add the new shape, ship, drop the old one
next time), or, if no deployed version reads what is being removed, add the file
to ACKNOWLEDGED in scripts/check-migration-compat.ts with the reason.
`);
  process.exit(1);
}

console.info(`PASS: ${readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length} migrations checked, none break a rollback`);
