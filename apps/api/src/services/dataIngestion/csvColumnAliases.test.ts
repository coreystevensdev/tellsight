import { describe, it, expect } from 'vitest';
import { CSV_REQUIRED_COLUMNS } from 'shared/constants';

import { COLUMN_ALIASES, buildHeaderMap, csvAdapter } from './csvAdapter.js';

// FR61: a CSV keeps the column names the exporting tool gave it, multi-word ones
// included, so an owner does not rename headers before uploading.
//
// Derived from COLUMN_ALIASES rather than listing the aliases again. A
// traceability run on 2026-11-21 found most of that table unexercised: a handful
// of aliases had tests and the rest were added and never covered, which an
// enumerated test file reproduces the moment someone adds the next one. Driving
// the cases off the exported map means a new alias arrives already covered, or
// fails here.
//
// Each alias is checked in isolation, which also keeps the `amount` precedence
// rule out of the way: an export carrying several money columns at once is a
// different question and csvAdapter.test.ts covers it.

const PAIRS = Object.entries(COLUMN_ALIASES).flatMap(([canonical, aliases]) =>
  aliases.map((alias) => ({ canonical, alias })),
);

/** `net_sales` to `Net Sales`, the shape a real export actually writes. */
function asExportHeader(alias: string): string {
  return alias
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The canonical required headers, with the column under test swapped for the
 * alias. An optional column's alias is appended instead, since dropping a
 * required column would fail validation for an unrelated reason.
 */
function headersUsing(canonical: string, header: string): string[] {
  const required = CSV_REQUIRED_COLUMNS.map((c) => (c === canonical ? header : c));
  return (CSV_REQUIRED_COLUMNS as readonly string[]).includes(canonical)
    ? required
    : [...required, header];
}

describe('every COLUMN_ALIASES entry resolves', () => {
  it('has aliases to check, so this cannot pass vacuously', () => {
    expect(PAIRS.length).toBeGreaterThan(20);
    expect(Object.keys(COLUMN_ALIASES).length).toBeGreaterThanOrEqual(6);
  });

  it.each(PAIRS)('maps $alias to $canonical', ({ canonical, alias }) => {
    const map = buildHeaderMap(headersUsing(canonical, alias));
    expect(map.get(canonical)).toBe(alias);
  });

  // The half of FR61 that names itself: "multi-word ones included".
  it.each(PAIRS)('maps the export spelling of $alias to $canonical', ({ canonical, alias }) => {
    const header = asExportHeader(alias);
    const map = buildHeaderMap(headersUsing(canonical, header));
    expect(map.get(canonical)).toBe(header);
  });
});

describe('a file whose only money column is an alias still parses', () => {
  // buildHeaderMap resolving a name is not the same as a file importing. These
  // run the whole parse for the amount aliases, since that is the column where a
  // wrong pick is silent: the rows import and the figures are the wrong measure.
  it.each(COLUMN_ALIASES.amount!.map((alias) => ({ alias })))(
    'reads the value from $alias',
    ({ alias }) => {
      const header = asExportHeader(alias);
      const csv = `Date,${header},Category\n2025-01-15,1200.00,Widget\n`;
      const result = csvAdapter.parse(Buffer.from(csv, 'utf-8'));

      // ParseResult carries no errors field; a rejected file comes back with
      // rows emptied and rowCount still set, which is what rows-vs-rowCount pins.
      expect(result.rowCount).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]![header]).toBe('1200.00');
    },
  );
});

describe('aliases do not collide', () => {
  // An alias listed under two canonicals would make one of them unreachable, and
  // which one wins would depend on object key order rather than on a decision.
  it('gives no alias to two different columns', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const { canonical, alias } of PAIRS) {
      const prior = owner.get(alias);
      if (prior && prior !== canonical) collisions.push(`${alias}: ${prior} and ${canonical}`);
      owner.set(alias, canonical);
    }
    expect(collisions).toEqual([]);
  });

  // 'name' is a label alias and deliberately not a counterparty one. The comment
  // in csvAdapter.ts says why; this is the assertion that keeps it true.
  it('keeps name out of the counterparty aliases', () => {
    expect(COLUMN_ALIASES.label).toContain('name');
    expect(COLUMN_ALIASES.counterparty).not.toContain('name');
  });
});
