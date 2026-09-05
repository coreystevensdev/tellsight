import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, it, expect } from 'vitest';

import { dbAdmin } from '../lib/db.js';
import * as schema from './schema.js';

// schema.test.ts reflects on the Drizzle table objects and never touches a
// database, and the migrations here are hand-authored rather than generated. So
// a column added to schema.ts with no matching file in drizzle/migrations passes
// every unit test, and the failure surfaces as a runtime SQL error in whichever
// environment ran the migrations.
//
// This compares the two directly: what the code believes the schema is, against
// what a migrated database actually has.

// The module exports enums and relations alongside tables, and the union of
// those is not narrowable directly, so this widens before filtering.
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((table) => getTableConfig(table));

type LiveColumn = {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
};

async function liveColumns(): Promise<Map<string, Map<string, LiveColumn>>> {
  const rows = await dbAdmin.execute<LiveColumn>(sql`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);

  const byTable = new Map<string, Map<string, LiveColumn>>();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Map());
    byTable.get(row.table_name)!.set(row.column_name, row);
  }
  return byTable;
}

describe('schema.ts against the migrated database', () => {
  // Without this the whole file passes if the table filter stops matching.
  it('found the tables it means to compare', () => {
    const names = TABLES.map((t) => t.name);

    expect(names.length).toBeGreaterThanOrEqual(19);
    expect(names).toContain('users');
    expect(names).toContain('datasets');
    expect(names).toContain('data_rows');
  });

  it('has every table schema.ts declares', async () => {
    const live = await liveColumns();
    const missing = TABLES.map((t) => t.name).filter((name) => !live.has(name));

    expect(missing, `declared in schema.ts, absent from the database: ${missing.join(', ')}`).toEqual([]);
  });

  // The direction that bites: someone edits schema.ts, the types compile, every
  // mocked test passes, and the column only fails when a query runs.
  it('has every column schema.ts declares', async () => {
    const live = await liveColumns();
    const missing: string[] = [];

    for (const table of TABLES) {
      const columns = live.get(table.name);
      if (!columns) continue; // reported by the test above
      for (const col of table.columns) {
        if (!columns.has(col.name)) missing.push(`${table.name}.${col.name}`);
      }
    }

    expect(missing, `declared in schema.ts, absent from the database: ${missing.join(', ')}`).toEqual([]);
  });

  // The other direction: a migration adds a column and schema.ts is never
  // updated, so the ORM silently cannot read or write it.
  it('declares every column the database has', async () => {
    const live = await liveColumns();
    const undeclared: string[] = [];

    for (const table of TABLES) {
      const columns = live.get(table.name);
      if (!columns) continue;
      const declared = new Set(table.columns.map((c) => c.name));
      for (const name of columns.keys()) {
        if (!declared.has(name)) undeclared.push(`${table.name}.${name}`);
      }
    }

    expect(undeclared, `in the database, absent from schema.ts: ${undeclared.join(', ')}`).toEqual([]);
  });

  // Nullability is the drift a hand-authored migration gets wrong most easily:
  // notNull in the code and nullable in the database means inserts the types
  // permit are rejected, and the reverse means reads the types call safe are not.
  it('agrees with the database on which columns are nullable', async () => {
    const live = await liveColumns();
    const mismatches: string[] = [];

    for (const table of TABLES) {
      const columns = live.get(table.name);
      if (!columns) continue;
      for (const col of table.columns) {
        const liveCol = columns.get(col.name);
        if (!liveCol) continue;
        const liveNotNull = liveCol.is_nullable === 'NO';
        if (col.notNull !== liveNotNull) {
          mismatches.push(
            `${table.name}.${col.name}: schema says ${col.notNull ? 'NOT NULL' : 'nullable'}, database says ${liveNotNull ? 'NOT NULL' : 'nullable'}`,
          );
        }
      }
    }

    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });
});
