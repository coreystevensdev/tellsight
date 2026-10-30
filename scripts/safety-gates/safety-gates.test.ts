import { describe, expect, it } from 'vitest';

import { classifyAudit, parseAuditReport } from './dependency-audit.js';
import { findUncoveredSecretRoutes, parseBearerTokenPrefixes } from './log-redaction.js';
import {
  classifyMigration,
  extractJsonbColumns,
  findMigrationFindings,
} from './migration-compat.js';

describe('migration compatibility gate', () => {
  it('extracts explicit and inferred JSONB column names without duplicates', () => {
    const schema = `
      profile: jsonb('business_profile'),
      keyStats: jsonb(),
      duplicate: jsonb('business_profile'),
    `;
    expect(extractJsonbColumns(schema)).toEqual(['business_profile', 'keyStats']);
  });

  it('detects every relational operation that can break a rolled-back image', () => {
    const sql = `
      ALTER TABLE users DROP COLUMN legacy;
      DROP TABLE old_events;
      ALTER TABLE orgs RENAME COLUMN old_name TO new_name;
      ALTER TABLE widgets RENAME TO products;
      ALTER TABLE totals ALTER COLUMN amount SET DATA TYPE numeric;
      ALTER TABLE users ALTER COLUMN email SET NOT NULL;
    `;
    expect(classifyMigration(sql, [])).toEqual([
      'DROP COLUMN',
      'DROP TABLE',
      'RENAME COLUMN',
      'RENAME TO',
      'SET DATA TYPE',
      'SET NOT NULL',
    ]);
  });

  it('ignores policy words in line comments', () => {
    expect(classifyMigration('-- DROP TABLE is intentionally not used\nSELECT 1;', [])).toEqual([]);
  });

  it('flags writes to quoted or unquoted JSONB columns but not ON UPDATE clauses', () => {
    expect(
      classifyMigration(
        'UPDATE orgs SET "business_profile" = business_profile || $1;',
        ['business_profile'],
      ),
    ).toEqual(['JSONB WRITE (business_profile)']);
    expect(
      classifyMigration('FOREIGN KEY (org_id) REFERENCES orgs(id) ON UPDATE NO ACTION;', [
        'business_profile',
      ]),
    ).toEqual([]);
  });

  it('reports only unacknowledged migrations in stable filename order', () => {
    const findings = findMigrationFindings(
      {
        '0003_drop.sql': 'ALTER TABLE users DROP COLUMN old;',
        '0001_safe.sql': 'ALTER TABLE users ADD COLUMN nickname text;',
        '0002_ack.sql': 'DROP TABLE retired;',
      },
      [],
      new Set(['0002_ack.sql']),
    );
    expect(findings).toEqual([{ file: '0003_drop.sql', hits: ['DROP COLUMN'] }]);
  });
});

describe('access-log redaction gate', () => {
  it('parses matcher prefixes and removes only the trailing wildcard', () => {
    const workflow = '  @bearertoken path /invite/* /api/digest/unsubscribe/*';
    expect(parseBearerTokenPrefixes(workflow)).toEqual([
      '/invite/',
      '/api/digest/unsubscribe/',
    ]);
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
