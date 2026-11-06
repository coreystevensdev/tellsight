import { describe, expect, it } from 'vitest';

import { classifyAudit, parseAuditReport } from './dependency-audit.js';
import { findUncoveredSecretRoutes, parseBearerTokenPrefixes } from './log-redaction.js';
import {
  type Acknowledgement,
  classifyMigration,
  findMigrationFindings,
} from './migration-compat.js';

function ack(hits: string[], reason = 'reviewed'): Acknowledgement {
  return { hits, reason };
}

describe('migration compatibility gate', () => {
  it('detects every relational operation that can break a rolled-back image', () => {
    const sql = `
      ALTER TABLE users DROP COLUMN legacy;
      DROP TABLE old_events;
      ALTER TABLE orgs RENAME COLUMN old_name TO new_name;
      ALTER TABLE widgets RENAME TO products;
      ALTER TABLE totals ALTER COLUMN amount SET DATA TYPE numeric;
      ALTER TABLE users ALTER COLUMN email SET NOT NULL;
    `;
    expect(classifyMigration(sql)).toEqual([
      'DROP COLUMN',
      'DROP TABLE',
      'RENAME COLUMN',
      'RENAME TO',
      'SET DATA TYPE',
      'SET NOT NULL',
    ]);
  });

  it('ignores policy words in comments, wherever the comment sits', () => {
    expect(classifyMigration('-- DROP TABLE is intentionally not used\nSELECT 1;')).toEqual([]);
    expect(classifyMigration('SELECT 1; -- DROP TABLE would be wrong here')).toEqual([]);
    expect(classifyMigration('/* DROP TABLE old_events; */\nSELECT 1;')).toEqual([]);
  });

  it('reads a referential action as a clause, not as a data write', () => {
    // 24 of the repo's 46 migrations carry one of these, so treating the
    // keyword as a statement would flag over half the history.
    expect(
      classifyMigration(
        'FOREIGN KEY (org_id) REFERENCES orgs(id) ON UPDATE NO ACTION ON DELETE CASCADE;',
      ),
    ).toEqual([]);
    expect(classifyMigration('FOREIGN KEY (x) REFERENCES y(id) ON DELETE SET NULL;')).toEqual([]);
    expect(classifyMigration('FOREIGN KEY (x) REFERENCES y(id) ON DELETE RESTRICT;')).toEqual([]);
  });

  it('flags a data write however the assignment is spelled', () => {
    // Each of these escaped a check that matched on column names. They are
    // listed one per case so a regression names the shape that came back.
    const escapees = [
      // a subquery's FROM used to end the scan before the real assignment
      `UPDATE "data_rows" SET "label" = (SELECT "name" FROM "orgs"), "source_id" = 'x';`,
      // a trailing comment's prose used to be read as SQL keywords
      `UPDATE "data_rows"\nSET -- prefix taken from the txnType we store\n  "source_id" = 'x';`,
      `UPDATE data_rows SET /* see WHERE clause below */ source_id = 'x';`,
      // a semicolon inside a string literal used to end the statement early
      `UPDATE "data_rows" SET "label" = 'legacy;import', "source_id" = 'x';`,
      // postgres multi-column assignment never matched `col =` at all
      `UPDATE "data_rows" SET ("source_id", "category") = ('a', 'b');`,
      // unique via column-level .unique(), so never on any watch list
      `UPDATE "users" SET "email" = lower("email");`,
      `UPDATE "orgs" SET "slug" = "slug" || '-2';`,
      // a primary key, likewise absent from a uniqueIndex() watch list
      `UPDATE "digest_preferences" SET "id" = "id" + 1;`,
      `DELETE FROM "data_rows" WHERE "source_type" = 'quickbooks';`,
      `update data_rows set source_id = 'x';`,
    ];
    for (const sql of escapees) {
      expect(classifyMigration(sql), sql).toEqual(['DATA WRITE']);
    }
  });

  it('separates a schema change from a data write in the same file', () => {
    expect(
      classifyMigration('ALTER TABLE t DROP COLUMN old;\nUPDATE t SET name = lower(name);'),
    ).toEqual(['DROP COLUMN', 'DATA WRITE']);
  });

  it('reports only unacknowledged migrations in stable filename order', () => {
    const findings = findMigrationFindings(
      {
        '0003_drop.sql': 'ALTER TABLE users DROP COLUMN old;',
        '0001_safe.sql': 'ALTER TABLE users ADD COLUMN nickname text;',
        '0002_ack.sql': 'DROP TABLE retired;',
      },
      new Map([['0002_ack.sql', ack(['DROP TABLE'])]]),
    );
    expect(findings).toEqual([{ file: '0003_drop.sql', hits: ['DROP COLUMN'] }]);
  });

  it('does not accept an acknowledgement whose reason is blank', () => {
    // The gate's whole bargain is that a human wrote a sentence, and nothing
    // used to check that the sentence existed.
    const migrations = { '0001_x.sql': 'DROP TABLE retired;' };
    expect(
      findMigrationFindings(migrations, new Map([['0001_x.sql', ack(['DROP TABLE'], '')]])),
    ).toEqual([{ file: '0001_x.sql', hits: ['DROP TABLE'] }]);
    expect(
      findMigrationFindings(migrations, new Map([['0001_x.sql', ack(['DROP TABLE'], '   ')]])),
    ).toEqual([{ file: '0001_x.sql', hits: ['DROP TABLE'] }]);
  });

  it('re-flags an acknowledged migration that grew a second operation', () => {
    // An acknowledgement used to exempt the whole file, so appending a
    // DROP COLUMN to a reviewed data migration inherited its sentence.
    expect(
      findMigrationFindings(
        { '0001_x.sql': 'UPDATE t SET a = 1;\nALTER TABLE t DROP COLUMN b;' },
        new Map([['0001_x.sql', ack(['DATA WRITE'])]]),
      ),
    ).toEqual([{ file: '0001_x.sql', hits: ['DROP COLUMN', 'DATA WRITE'] }]);
  });

  it('accepts an acknowledgement that names every hit, in any order', () => {
    expect(
      findMigrationFindings(
        { '0001_x.sql': 'UPDATE t SET a = 1;\nALTER TABLE t DROP COLUMN b;' },
        new Map([['0001_x.sql', ack(['DATA WRITE', 'DROP COLUMN'])]]),
      ),
    ).toEqual([]);
  });
});

describe('access-log redaction gate', () => {
  it('parses matcher prefixes and removes only the trailing wildcard', () => {
    const workflow = '  @bearertoken path /invite/* /api/digest/unsubscribe/*';
    expect(parseBearerTokenPrefixes(workflow)).toEqual(['/invite/', '/api/digest/unsubscribe/']);
  });

  it('fails closed when the Caddy matcher disappears', () => {
    expect(() => parseBearerTokenPrefixes('reverse_proxy web:3000')).toThrow(
      'no @bearertoken matcher',
    );
  });

  it('finds uncovered routes without confusing sibling prefixes', () => {
    expect(
      findUncoveredSecretRoutes(
        ['/invite', '/api/invites', '/api/invites-admin'],
        ['/invite/', '/api/invites/'],
      ),
    ).toEqual(['/api/invites-admin']);
  });
});

describe('dependency-audit gate', () => {
  const high = {
    module_name: 'unsafe-package',
    severity: 'high',
    title: 'Prototype pollution',
  };

  it('parses pnpm reports with advisories and reports without them', () => {
    expect(parseAuditReport(JSON.stringify({ advisories: { 1: high } }))).toEqual([high]);
    expect(parseAuditReport('{}')).toEqual([]);
  });

  it('blocks unacknowledged high and critical advisories but ignores moderate ones', () => {
    const moderate = { ...high, module_name: 'moderate-package', severity: 'moderate' };
    const result = classifyAudit([high, moderate], []);
    expect(result.blocking).toEqual([high]);
    expect(result.unacknowledged).toEqual([high]);
  });

  it('separates covered acknowledgements from stale entries', () => {
    const active = {
      module: 'unsafe-package',
      reviewed: '2026-10-30',
      reason: 'not reachable',
      revisit: 'when a patched version exists',
    };
    const stale = { ...active, module: 'fixed-package' };
    const result = classifyAudit([high], [active, stale]);
    expect(result.unacknowledged).toEqual([]);
    expect(result.covered).toEqual([active]);
    expect(result.obsolete).toEqual([stale]);
  });

  it('throws on malformed audit JSON instead of silently passing', () => {
    expect(() => parseAuditReport('{not json')).toThrow();
  });
});
