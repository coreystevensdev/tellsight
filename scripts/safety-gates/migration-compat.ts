export interface MigrationFinding {
  file: string;
  hits: string[];
}

export interface Acknowledgement {
  /** The exact hits this was reviewed against, so a migration that grows a new one is flagged again. */
  hits: string[];
  reason: string;
}

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { label: 'RENAME COLUMN', pattern: /\bRENAME\s+COLUMN\b/i },
  { label: 'RENAME TO', pattern: /\bRENAME\s+TO\b/i },
  { label: 'SET DATA TYPE', pattern: /\bSET\s+DATA\s+TYPE\b/i },
  { label: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
];

// A referential action is a clause, not a statement. This is the entire
// vocabulary, so removing them leaves only real UPDATE and DELETE behind.
// Without it every table carrying ON DELETE CASCADE reads as a data write,
// which is 24 of the 46 files here.
const REFERENTIAL_ACTION =
  /\bON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)/gi;

// Comments anywhere, not only lines that open with one. Dropping whole comment
// lines alone left a trailing comment in the policy text where its prose was
// read as SQL: "-- prefix taken from the txnType" ended a statement at its
// "from" and hid every assignment below it.
function executableSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// Any statement that rewrites existing rows, without trying to work out which
// columns move. Naming the column is what kept failing: an assignment could
// hide behind a subquery's FROM, a stop word inside a comment, or a semicolon
// in a string literal, and when the decoy was itself a watched column the gate
// named the decoy and stayed silent about the real write, which is worse than
// naming nothing. Which columns move, and why a rollback survives it, is what
// the acknowledgement is for.
export function classifyMigration(sql: string): string[] {
  const statements = executableSql(sql);
  const hits = PATTERNS.filter(({ pattern }) => pattern.test(statements)).map(({ label }) => label);
  if (/\b(?:UPDATE|DELETE)\b/i.test(statements.replace(REFERENTIAL_ACTION, ' '))) {
    hits.push('DATA WRITE');
  }
  return hits;
}

export function findMigrationFindings(
  migrations: Record<string, string>,
  acknowledged: ReadonlyMap<string, Acknowledgement>,
): MigrationFinding[] {
  return Object.entries(migrations)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, sql]) => {
      const hits = classifyMigration(sql);
      if (hits.length === 0) return [];
      const ack = acknowledged.get(file);
      const reviewed =
        ack !== undefined &&
        ack.reason.trim().length > 0 &&
        [...ack.hits].sort().join('|') === [...hits].sort().join('|');
      return reviewed ? [] : [{ file, hits }];
    });
}
