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
  // format_type gives the fully-qualified form with precision, matching what
  // Drizzle's getSQLType() produces once the aliases below are applied.
  sql_type: string;
};

async function liveColumns(): Promise<Map<string, Map<string, LiveColumn>>> {
  const rows = await dbAdmin.execute<LiveColumn>(sql`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
           format_type(a.atttypid, a.atttypmod) AS sql_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
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

  // Tables in the other direction. Without this, deleting a whole table from
  // schema.ts passes, because every assertion here iterates what is declared.
  it('declares every table the database has', async () => {
    const live = await liveColumns();
    const declared = new Set(TABLES.map((t) => t.name));
    // Drizzle's own bookkeeping table is not part of the application schema.
    const undeclared = [...live.keys()].filter(
      (name) => !declared.has(name) && !name.startsWith('__drizzle'),
    );

    expect(undeclared, `in the database, absent from schema.ts: ${undeclared.join(', ')}`).toEqual([]);
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

// Postgres and Drizzle spell the same type differently in a handful of cases,
// and serial is integer plus a default rather than a type of its own.
const TYPE_ALIASES: Record<string, string> = {
  serial: 'integer',
  bigserial: 'bigint',
  'timestamp with time zone': 'timestamptz',
  timestamptz: 'timestamptz',
};

function normalizeType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const aliased = TYPE_ALIASES[lower] ?? lower;
  return aliased
    .replace(/^character varying/, 'varchar')
    // Drizzle writes numeric(12, 2), format_type writes numeric(12,2).
    .replace(/,\s+/g, ',')
    .replace(/\s+/g, ' ');
}

describe('schema.ts column types against the migrated database', () => {
  // A column declared integer where the database has text passes every other
  // assertion in this file: the name matches and the nullability matches.
  it('agrees on the type of every column', async () => {
    const live = await liveColumns();
    const mismatches: string[] = [];

    for (const table of TABLES) {
      const columns = live.get(table.name);
      if (!columns) continue;
      for (const col of table.columns) {
        const liveCol = columns.get(col.name);
        if (!liveCol) continue;
        const declared = normalizeType(col.getSQLType());
        const actual = normalizeType(liveCol.sql_type);
        if (declared !== actual) {
          mismatches.push(`${table.name}.${col.name}: schema says ${declared}, database says ${actual}`);
        }
      }
    }

    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });
});

// Every onConflictDoNothing({ target: [...] }) and onConflictDoUpdate in the
// codebase needs a matching unique index to exist, and Postgres raises 42P10 at
// runtime if it does not. Those indexes are the whole idempotency and dedup
// substrate: digest sends, milestone awards, AI summary uniqueness, analytics
// dedupe keys, subscription identity. Comparing columns alone cannot see one go
// missing, which is the drift a hand-authored migration produces most easily.
describe('schema.ts indexes against the migrated database', () => {
  type LiveIndex = { tablename: string; indexname: string; is_unique: boolean };

  async function liveIndexes() {
    const rows = await dbAdmin.execute<LiveIndex>(sql`
      SELECT tablename, indexname, indexdef ~ 'UNIQUE' AS is_unique
      FROM pg_indexes
      WHERE schemaname = 'public'
    `);
    const byTable = new Map<string, Map<string, LiveIndex>>();
    for (const row of rows) {
      if (!byTable.has(row.tablename)) byTable.set(row.tablename, new Map());
      byTable.get(row.tablename)!.set(row.indexname, row);
    }
    return byTable;
  }

  function declaredIndexes(table: (typeof TABLES)[number]) {
    return table.indexes.map((idx) => {
      const config = (idx as unknown as { config: { name: string; unique: boolean } }).config;
      return { name: config.name, unique: config.unique };
    });
  }

  it('found indexes to compare, so this file cannot pass vacuously', () => {
    const total = TABLES.reduce((n, t) => n + declaredIndexes(t).length, 0);

    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('has every index schema.ts declares', async () => {
    const live = await liveIndexes();
    const missing: string[] = [];

    for (const table of TABLES) {
      const indexes = live.get(table.name);
      for (const declared of declaredIndexes(table)) {
        if (!indexes?.has(declared.name)) missing.push(`${table.name}.${declared.name}`);
      }
    }

    expect(missing, `declared in schema.ts, absent from the database: ${missing.join(', ')}`).toEqual([]);
  });

  // A unique index demoted to a plain one keeps the name and the columns, so the
  // check above still passes while every upsert targeting it starts failing.
  it('agrees on which indexes are unique', async () => {
    const live = await liveIndexes();
    const mismatches: string[] = [];

    for (const table of TABLES) {
      const indexes = live.get(table.name);
      for (const declared of declaredIndexes(table)) {
        const actual = indexes?.get(declared.name);
        if (!actual) continue;
        if (declared.unique !== actual.is_unique) {
          mismatches.push(
            `${table.name}.${declared.name}: schema says ${declared.unique ? 'UNIQUE' : 'non-unique'}, database says ${actual.is_unique ? 'UNIQUE' : 'non-unique'}`,
          );
        }
      }
    }

    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });

  // The other direction, and the one that matters most here. Checking only that
  // declared indexes exist means deleting the declaration passes: there is
  // nothing left to look for. An index dropped from schema.ts still exists in
  // the database, so upserts keep working, and the next person to read the file
  // sees no index and writes a migration to drop it.
  //
  // Constraint-backed indexes (primary keys, unique constraints) are excluded:
  // Postgres creates those implicitly and schema.ts never declares them as
  // index() entries.
  it('declares every index the database has', async () => {
    const live = await liveIndexes();
    const constraintBacked = await dbAdmin.execute<{ indexname: string }>(sql`
      SELECT conindid::regclass::text AS indexname
      FROM pg_constraint
      WHERE conindid <> 0
    `);
    const implicit = new Set(constraintBacked.map((r) => r.indexname));
    const declaredNames = new Set(TABLES.flatMap((t) => declaredIndexes(t).map((i) => i.name)));

    const undeclared: string[] = [];
    for (const table of TABLES) {
      for (const name of live.get(table.name)?.keys() ?? []) {
        if (implicit.has(name)) continue;
        if (!declaredNames.has(name)) undeclared.push(`${table.name}.${name}`);
      }
    }

    expect(undeclared, `in the database, absent from schema.ts: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('has every unique constraint schema.ts declares', async () => {
    const rows = await dbAdmin.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'u'
    `);
    const liveNames = new Set(rows.map((r) => r.conname));

    const missing = TABLES.flatMap((t) =>
      (t.uniqueConstraints ?? [])
        .map((u) => (u as unknown as { name: string }).name)
        .filter((name) => name && !liveNames.has(name))
        .map((name) => `${t.name}.${name}`),
    );

    expect(missing, `declared in schema.ts, absent from the database: ${missing.join(', ')}`).toEqual([]);
  });
});
