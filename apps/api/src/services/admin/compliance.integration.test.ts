import { describe, it, expect } from 'vitest';

import { getEmailComplianceMetrics, getAlertComplianceMetrics } from './complianceService.js';

// Both functions are raw SQL against real tables, and complianceService.test.ts
// mocks dbAdmin.execute and replaces the sql tag, so the statements themselves
// are never sent anywhere. That is how `WHERE tier = 'pro'` shipped against a
// subscriptions table whose column is `plan`: six green tests, and
// /admin/email-compliance returning 500 in production.
//
// These call the real functions against real Postgres. They assert almost
// nothing about the values, on purpose. The point is that the SQL parses,
// every column exists, and the row mapping lines up with the aliases.

describe('compliance metrics against real Postgres', () => {
  it('getEmailComplianceMetrics runs and maps every field', async () => {
    const m = await getEmailComplianceMetrics();

    // Drift is caught by column() throwing on a missing key, not by these
    // assertions: Number(row[key] ?? 0) reads a missing column back as 0, which
    // is finite. These only check that what did arrive maps to numbers.
    for (const value of [m.totalProUsers, m.cadenceActiveUsers]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const window of [m.d7, m.d30]) {
      for (const [key, value] of Object.entries(window)) {
        expect(Number.isFinite(value), `${key} is not a number`).toBe(true);
      }
    }
    expect(new Date(m.computedAt).toString()).not.toBe('Invalid Date');
  });

  it('getAlertComplianceMetrics runs and maps every field', async () => {
    const m = await getAlertComplianceMetrics();

    expect(Number.isFinite(m.totalRules)).toBe(true);
    expect(Number.isFinite(m.mutedRules)).toBe(true);
    for (const window of [m.d7, m.d30]) {
      expect(Number.isFinite(window.fired)).toBe(true);
      expect(Number.isFinite(window.quotaSuppressed)).toBe(true);
    }

    // The kinds CTE cross-joins enum_range, so every alert_rule_kind gets a row
    // even with no rules. An empty array means that join broke.
    expect(m.byRuleKind.length).toBeGreaterThan(0);
    for (const k of m.byRuleKind) {
      expect(typeof k.ruleKind).toBe('string');
      expect(Number.isFinite(k.totalRules)).toBe(true);
      expect(Number.isFinite(k.candidateDefaultOffRules)).toBe(true);
    }
  });
});
