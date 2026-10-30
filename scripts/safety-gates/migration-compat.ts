export interface MigrationFinding {
  file: string;
  hits: string[];
}

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { label: 'RENAME COLUMN', pattern: /\bRENAME\s+COLUMN\b/i },
  { label: 'RENAME TO', pattern: /\bRENAME\s+TO\b/i },
  { label: 'SET DATA TYPE', pattern: /\bSET\s+DATA\s+TYPE\b/i },
  { label: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
];

export function extractJsonbColumns(schemaSource: string): string[] {
  const explicit = [...schemaSource.matchAll(/jsonb\('([a-z_]+)'\)/g)].map(
    (match) => match[1]!,
  );
  const inferred = [...schemaSource.matchAll(/(\w+)\s*:\s*jsonb\(\)/g)].map(
    (match) => match[1]!,
  );
  return [...new Set([...explicit, ...inferred])];
}

export function classifyMigration(sql: string, jsonbColumns: string[]): string[] {
  // A rationale in a line comment may name a destructive operation without
  // executing one. Strip those comments before applying the policy patterns.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  const hits = PATTERNS.filter(({ pattern }) => pattern.test(statements)).map(
    ({ label }) => label,
  );
  const written = jsonbColumns.filter((column) =>
    new RegExp(`\\bSET\\s+"?${column}"?\\s*=`, 'i').test(statements),
  );
  if (written.length > 0) hits.push(`JSONB WRITE (${written.join(', ')})`);
  return hits;
}

export function findMigrationFindings(
  migrations: Record<string, string>,
  jsonbColumns: string[],
  acknowledged: ReadonlySet<string>,
): MigrationFinding[] {
  return Object.entries(migrations)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, sql]) => {
      const hits = classifyMigration(sql, jsonbColumns);
      return hits.length > 0 && !acknowledged.has(file) ? [{ file, hits }] : [];
    });
}
