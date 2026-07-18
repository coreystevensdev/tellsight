import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();

vi.mock('../../lib/db.js', () => ({
  dbAdmin: { execute: mockExecute },
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    _tag: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

const { getEmailComplianceMetrics, getAlertComplianceMetrics } = await import('./complianceService.js');

describe('getEmailComplianceMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps row keys to the typed 7d + 30d window shape', async () => {
    mockExecute.mockResolvedValueOnce([
      {
        total_pro_users: 42,
        cadence_active_users: 30,
        unsub_7d: 3, bounce_7d: 1, complaint_7d: 0, sent_7d: 200, opened_7d: 90, clicked_7d: 30,
        unsub_30d: 11, bounce_30d: 4, complaint_30d: 1, sent_30d: 800, opened_30d: 360, clicked_30d: 120,
      },
    ]);

    const m = await getEmailComplianceMetrics();

    expect(m.totalProUsers).toBe(42);
    expect(m.cadenceActiveUsers).toBe(30);
    expect(m.d7).toEqual({
      unsubscribed: 3, bounced: 1, complained: 0, digestsSent: 200, opened: 90, clicked: 30,
    });
    expect(m.d30).toEqual({
      unsubscribed: 11, bounced: 4, complained: 1, digestsSent: 800, opened: 360, clicked: 120,
    });
    expect(typeof m.computedAt).toBe('string');
    expect(new Date(m.computedAt).toString()).not.toBe('Invalid Date');
  });

  it('returns zeros across both windows when the result row is empty', async () => {
    mockExecute.mockResolvedValueOnce([]);

    const m = await getEmailComplianceMetrics();

    expect(m.totalProUsers).toBe(0);
    expect(m.cadenceActiveUsers).toBe(0);
    expect(m.d7).toEqual({
      unsubscribed: 0, bounced: 0, complained: 0, digestsSent: 0, opened: 0, clicked: 0,
    });
    expect(m.d30).toEqual({
      unsubscribed: 0, bounced: 0, complained: 0, digestsSent: 0, opened: 0, clicked: 0,
    });
  });

  it('coerces string-shaped counts (driver may return text from COUNT)', async () => {
    mockExecute.mockResolvedValueOnce([
      {
        total_pro_users: '15', cadence_active_users: '12',
        unsub_7d: '2', bounce_7d: '0', complaint_7d: '1', sent_7d: '100', opened_7d: '45', clicked_7d: '12',
        unsub_30d: '5', bounce_30d: '0', complaint_30d: '2', sent_30d: '400', opened_30d: '180', clicked_30d: '48',
      },
    ]);

    const m = await getEmailComplianceMetrics();

    expect(m.totalProUsers).toBe(15);
    expect(m.cadenceActiveUsers).toBe(12);
    expect(m.d7.complained).toBe(1);
    expect(m.d7.opened).toBe(45);
    expect(m.d7.clicked).toBe(12);
    expect(m.d30.bounced).toBe(0);
    expect(m.d30.opened).toBe(180);
    expect(m.d30.clicked).toBe(48);
  });

  it('embeds bounce, complaint, and sent event names in the SQL bindings', async () => {
    mockExecute.mockResolvedValueOnce([{}]);

    await getEmailComplianceMetrics();

    const arg = mockExecute.mock.calls[0]![0] as { values: unknown[] };
    expect(arg.values).toContain('email.bounced');
    expect(arg.values).toContain('email.complained');
    expect(arg.values).toContain('digest.sent');
  });

  it('embeds the engagement event names + COUNT(DISTINCT) shape (AC #6)', async () => {
    mockExecute.mockResolvedValueOnce([{}]);

    await getEmailComplianceMetrics();

    const arg = mockExecute.mock.calls[0]![0] as { values: unknown[]; text: string };
    expect(arg.values).toContain('digest.opened');
    expect(arg.values).toContain('digest.clicked');
    // Server-side dedupe shape: per-user-per-week, JSONB extract on weekStart
    expect(arg.text).toContain("COUNT(DISTINCT (user_id, metadata->>'weekStart'))");
  });

  it('queries both 7-day and 30-day intervals', async () => {
    mockExecute.mockResolvedValueOnce([{}]);

    await getEmailComplianceMetrics();

    const arg = mockExecute.mock.calls[0]![0] as { text: string };
    expect(arg.text).toContain("INTERVAL '7 days'");
    expect(arg.text).toContain("INTERVAL '30 days'");
  });
});

describe('getAlertComplianceMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  const summaryRow = {
    total_rules: 12,
    muted_rules: 2,
    fired_7d: 5,
    quota_suppressed_7d: 1,
    fired_30d: 20,
    quota_suppressed_30d: 3,
  };

  const byKindRows = [
    { rule_kind: 'runway_runs_short', total_rules: 4, fired: 8, clicked: 2, candidate_default_off_rules: 1 },
    { rule_kind: 'margin_drops', total_rules: 3, fired: 0, clicked: 0, candidate_default_off_rules: 0 },
  ];

  it('maps the summary row and per-kind rows into the typed shape', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    const m = await getAlertComplianceMetrics();

    expect(m.totalRules).toBe(12);
    expect(m.mutedRules).toBe(2);
    expect(m.d7).toEqual({ fired: 5, quotaSuppressed: 1 });
    expect(m.d30).toEqual({ fired: 20, quotaSuppressed: 3 });
    expect(m.byRuleKind).toEqual([
      { ruleKind: 'runway_runs_short', totalRules: 4, fired: 8, clicked: 2, candidateDefaultOffRules: 1 },
      { ruleKind: 'margin_drops', totalRules: 3, fired: 0, clicked: 0, candidateDefaultOffRules: 0 },
    ]);
    expect(typeof m.computedAt).toBe('string');
  });

  it('returns zeros and an empty kind table when nothing exists yet', async () => {
    mockExecute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const m = await getAlertComplianceMetrics();

    expect(m.totalRules).toBe(0);
    expect(m.mutedRules).toBe(0);
    expect(m.d7).toEqual({ fired: 0, quotaSuppressed: 0 });
    expect(m.d30).toEqual({ fired: 0, quotaSuppressed: 0 });
    expect(m.byRuleKind).toEqual([]);
  });

  it('coerces string-shaped counts (driver may return text from COUNT)', async () => {
    mockExecute
      .mockResolvedValueOnce([{ ...summaryRow, total_rules: '12', fired_7d: '5' }])
      .mockResolvedValueOnce([{ ...byKindRows[0], total_rules: '4', fired: '8' }]);

    const m = await getAlertComplianceMetrics();

    expect(m.totalRules).toBe(12);
    expect(m.d7.fired).toBe(5);
    expect(m.byRuleKind[0]!.totalRules).toBe(4);
    expect(m.byRuleKind[0]!.fired).toBe(8);
  });

  it('embeds alert.fired, alert.quota_suppressed, and alert.clicked event names in the SQL bindings', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const summaryArg = mockExecute.mock.calls[0]![0] as { values: unknown[] };
    expect(summaryArg.values).toContain('alert.fired');
    expect(summaryArg.values).toContain('alert.quota_suppressed');

    const byKindArg = mockExecute.mock.calls[1]![0] as { values: unknown[] };
    expect(byKindArg.values).toContain('alert.clicked');
  });

  it('joins alert_rule_fires to analytics_events on the fireId metadata match, grouped by rule_kind', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toContain("metadata->>'fireId'");
    expect(byKindArg.text).toContain('GROUP BY r.id, r.kind');
    expect(byKindArg.text).toContain('GROUP BY kinds.rule_kind');
  });

  it('counts DISTINCT fires, not join rows, so a fire with two matching clicks is not double-counted as two fires', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toContain('COUNT(DISTINCT f.id)');
    expect(byKindArg.text).not.toMatch(/COUNT\(f\.id\)/);
  });

  it('counts click_count as distinct clicked fires, not raw click rows, so it can never exceed fire_count', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toContain('COUNT(DISTINCT f.id) FILTER (WHERE c.id IS NOT NULL) AS click_count');
  });

  it('windows the per-kind fire join to 30 days, matching every other metric in this file', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toMatch(/f\.fired_at >= NOW\(\) - INTERVAL '30 days'/);
  });

  it('flags candidate-default-off using a 7-day-elapsed fire with zero clicks, counted per rule not per fire', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toContain("INTERVAL '7 days'");
    expect(byKindArg.text).toContain('has_elapsed_fire AND rule_stats.click_count = 0');
  });

  it('cross-joins every rule_kind enum value so a kind with zero rules still appears', async () => {
    mockExecute.mockResolvedValueOnce([summaryRow]).mockResolvedValueOnce(byKindRows);

    await getAlertComplianceMetrics();

    const byKindArg = mockExecute.mock.calls[1]![0] as { text: string };
    expect(byKindArg.text).toContain('enum_range(NULL::alert_rule_kind)');
    expect(byKindArg.text).toContain('LEFT JOIN rule_stats');
  });
});
