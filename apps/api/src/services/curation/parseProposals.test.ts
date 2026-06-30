import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = { warn: vi.fn(), info: vi.fn() };
vi.mock('../../lib/logger.js', () => ({ logger: mockLogger }));

const { parseProposals } = await import('./parseProposals.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const allowed = new Set(['monthly_revenue', 'monthly_burn_rate', 'payroll_total']);

function validProposal(over: Record<string, unknown> = {}) {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Revenue dipped 15%',
    explanation: 'Month-over-month revenue fell by 15%.',
    recommendation: 'Consider reviewing your highest-cost categories.',
    confidence: 0.82,
    evidence: ['monthly_revenue'],
    dedupKey: 'trend:revenue:default',
    period: '2026-06',
    ...over,
  };
}

beforeEach(() => {
  mockLogger.warn.mockReset();
  mockLogger.info.mockReset();
});

// ── JSON parsing ──────────────────────────────────────────────────────────────

describe('malformed input', () => {
  it('returns an empty array on invalid JSON', () => {
    expect(parseProposals('{not json', allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });

  it('returns an empty array when JSON is not an array', () => {
    expect(parseProposals(JSON.stringify({ kind: 'trend' }), allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });

  it('returns an empty array for an empty array input', () => {
    expect(parseProposals('[]', allowed)).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

// ── schema validation ─────────────────────────────────────────────────────────

describe('schema validation', () => {
  it('returns a valid proposal unchanged', () => {
    const raw = JSON.stringify([validProposal()]);
    const result = parseProposals(raw, allowed);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'trend', title: 'Revenue dipped 15%' });
  });

  it('drops a proposal missing a required field', () => {
    const { title: _omit, ...noTitle } = validProposal();
    const raw = JSON.stringify([noTitle]);

    expect(parseProposals(raw, allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });

  it('drops a proposal with confidence out of range', () => {
    const raw = JSON.stringify([validProposal({ confidence: 1.5 })]);

    expect(parseProposals(raw, allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });

  it('drops a proposal whose recommendation uses directive voice', () => {
    const raw = JSON.stringify([validProposal({ recommendation: 'You should reduce payroll.' })]);

    expect(parseProposals(raw, allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });

  it('drops a proposal whose explanation uses directive voice', () => {
    const raw = JSON.stringify([validProposal({ explanation: 'You must act on this immediately.' })]);

    expect(parseProposals(raw, allowed)).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  });
});

// ── evidence allowlist ────────────────────────────────────────────────────────

describe('evidence scope enforcement', () => {
  it('drops a proposal whose evidence cites an out-of-scope stat ID', () => {
    const raw = JSON.stringify([validProposal({ evidence: ['monthly_revenue', 'raw_transaction_amount'] })]);

    expect(parseProposals(raw, allowed)).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outOfScope: ['raw_transaction_amount'] }),
      expect.any(String),
    );
  });

  it('drops a proposal whose entire evidence list is out of scope', () => {
    const raw = JSON.stringify([validProposal({ evidence: ['customer_name', 'invoice_amount'] })]);

    expect(parseProposals(raw, allowed)).toHaveLength(0);
  });

  it('passes a proposal whose evidence is entirely within the allowed set', () => {
    const raw = JSON.stringify([
      validProposal({ evidence: ['monthly_revenue', 'monthly_burn_rate'] }),
    ]);

    expect(parseProposals(raw, allowed)).toHaveLength(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});

// ── mixed input ───────────────────────────────────────────────────────────────

describe('mixed valid and invalid proposals', () => {
  it('returns only the valid proposals from a mixed array', () => {
    const raw = JSON.stringify([
      validProposal({ title: 'Good finding' }),
      validProposal({ confidence: 2.0 }),                                    // fails schema
      validProposal({ evidence: ['unknown_stat'], title: 'Out-of-scope' }),  // fails allowlist
      validProposal({ title: 'Also good' }),
    ]);

    const result = parseProposals(raw, allowed);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.title)).toEqual(['Good finding', 'Also good']);
    expect(mockLogger.warn).toHaveBeenCalledOnce();   // one schema failure
    expect(mockLogger.info).toHaveBeenCalledOnce();   // one evidence drop
  });
});
