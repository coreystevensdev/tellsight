import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries/index.js', () => ({
  dataRowsQueries: {
    getRowsByDataset: vi.fn(),
  },
  aiSummariesQueries: {
    getCachedSummary: vi.fn(),
    storeSummary: vi.fn(),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', () => {
  const scoring = JSON.stringify({
    version: '1.0',
    topN: 8,
    weights: { novelty: 0.35, actionability: 0.40, specificity: 0.25 },
    thresholds: { anomalyZScore: 2.0, trendMinDataPoints: 3, significantChangePercent: 10 },
  });

  const prompt = `You are a business analyst explaining financial data to a small business owner.
{{statSummaries}}
Stat types: {{statTypeList}}, Categories: {{categoryCount}}, Insights: {{insightCount}}`;

  return {
    readFileSync: vi.fn((...args: unknown[]) => {
      const p = String(args[0]);
      return p.includes('prompt-templates') ? prompt : scoring;
    }),
  };
});

vi.mock('../aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: vi.fn(),
}));

import { dataRowsQueries, aiSummariesQueries } from '../../db/queries/index.js';
import { generateInterpretation } from '../aiInterpretation/claudeClient.js';
import { runCurationPipeline, runFullPipeline } from './index.js';

const fixtureRows = [
  { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Sales', parentCategory: null, date: new Date('2026-01-01'), amount: '1000.00', label: 'A', metadata: null, createdAt: new Date() },
  { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Sales', parentCategory: null, date: new Date('2026-02-01'), amount: '1500.00', label: 'B', metadata: null, createdAt: new Date() },
  { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Sales', parentCategory: null, date: new Date('2026-03-01'), amount: '2000.00', label: 'C', metadata: null, createdAt: new Date() },
  { id: 4, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Marketing', parentCategory: null, date: new Date('2026-01-01'), amount: '500.00', label: 'D', metadata: null, createdAt: new Date() },
  { id: 5, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Marketing', parentCategory: null, date: new Date('2026-02-01'), amount: '600.00', label: 'E', metadata: null, createdAt: new Date() },
  { id: 6, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Marketing', parentCategory: null, date: new Date('2026-03-01'), amount: '550.00', label: 'F', metadata: null, createdAt: new Date() },
];

describe('runCurationPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('orchestrates computation -> scoring end-to-end', async () => {
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(fixtureRows as never);

    const insights = await runCurationPipeline(1, 1);

    expect(dataRowsQueries.getRowsByDataset).toHaveBeenCalledWith(1, 1, undefined);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.length).toBeLessThanOrEqual(8);

    for (const insight of insights) {
      expect(insight).toHaveProperty('stat');
      expect(insight).toHaveProperty('score');
      expect(insight).toHaveProperty('breakdown');
      expect(insight.stat).toHaveProperty('statType');
      expect(insight.stat).toHaveProperty('value');
    }
  });

  it('returns sorted by score descending', async () => {
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(fixtureRows as never);

    const insights = await runCurationPipeline(1, 1);

    for (let i = 1; i < insights.length; i++) {
      expect(insights[i - 1]!.score).toBeGreaterThanOrEqual(insights[i]!.score);
    }
  });

  it('returns empty array for empty dataset', async () => {
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue([]);

    const insights = await runCurationPipeline(1, 1);
    expect(insights).toEqual([]);
  });

  it('never leaks DataRow references into output', async () => {
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(fixtureRows as never);

    const insights = await runCurationPipeline(1, 1);

    for (const insight of insights) {
      const statKeys = Object.keys(insight.stat);
      expect(statKeys).not.toContain('orgId');
      expect(statKeys).not.toContain('datasetId');
      expect(statKeys).not.toContain('id');
      expect(statKeys).not.toContain('label');
      expect(statKeys).not.toContain('metadata');
    }
  });
});

describe('runFullPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached content on cache hit', async () => {
    vi.mocked(aiSummariesQueries.getCachedSummary).mockResolvedValue({
      id: 1,
      orgId: 1,
      datasetId: 1,
      content: 'Cached summary here.',
      transparencyMetadata: {},
      promptVersion: 'v1',
      isSeed: false,
      createdAt: new Date(),
      staleAt: null,
    } as never);

    const result = await runFullPipeline(1, 1);

    expect(result.content).toBe('Cached summary here.');
    expect(result.fromCache).toBe(true);
    expect(dataRowsQueries.getRowsByDataset).not.toHaveBeenCalled();
    expect(generateInterpretation).not.toHaveBeenCalled();
  });

  it('runs full pipeline and stores result on cache miss', async () => {
    vi.mocked(aiSummariesQueries.getCachedSummary).mockResolvedValue(undefined as never);
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(fixtureRows as never);
    vi.mocked(generateInterpretation).mockResolvedValue('Fresh AI analysis.');
    vi.mocked(aiSummariesQueries.storeSummary).mockResolvedValue({} as never);

    const result = await runFullPipeline(1, 1);

    expect(result.content).toBe('Fresh AI analysis.');
    expect(result.fromCache).toBe(false);
    expect(dataRowsQueries.getRowsByDataset).toHaveBeenCalledWith(1, 1, undefined);
    expect(generateInterpretation).toHaveBeenCalledWith(expect.stringContaining('business analyst'));
    expect(aiSummariesQueries.storeSummary).toHaveBeenCalledWith(
      1, 1,
      'Fresh AI analysis.',
      expect.objectContaining({ promptVersion: 'v1.5', insightCount: expect.any(Number) }),
      'v1.5',
    );
  });

  it('skips Claude call entirely on cache hit', async () => {
    vi.mocked(aiSummariesQueries.getCachedSummary).mockResolvedValue({
      id: 1,
      orgId: 1,
      datasetId: 1,
      content: 'From cache.',
      transparencyMetadata: {},
      promptVersion: 'v1',
      isSeed: false,
      createdAt: new Date(),
      staleAt: null,
    } as never);

    await runFullPipeline(1, 1);

    expect(generateInterpretation).not.toHaveBeenCalled();
    expect(aiSummariesQueries.storeSummary).not.toHaveBeenCalled();
  });

  it('strips hallucinated stat refs before cache write and returns the stripped content', async () => {
    vi.mocked(aiSummariesQueries.getCachedSummary).mockResolvedValue(undefined as never);
    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(fixtureRows as never);
    // LLM hallucinates a stat ID that's not in the pipeline output
    vi.mocked(generateInterpretation).mockResolvedValue(
      'Runway is tight <stat id="runaway"/> this quarter.',
    );
    vi.mocked(aiSummariesQueries.storeSummary).mockResolvedValue({} as never);

    const result = await runFullPipeline(1, 1);

    // return value matches what the next cache hit will return — no
    // asymmetry between first call and cache-hit call. Two spaces between
    // "tight" and "this" are intentional — stripInvalidStatRefs removes the
    // tag without collapsing surrounding whitespace.
    expect(result.content).toBe('Runway is tight  this quarter.');
    expect(result.fromCache).toBe(false);

    // cache receives the stripped version
    const storeCall = vi.mocked(aiSummariesQueries.storeSummary).mock.calls[0]!;
    expect(storeCall[2]).toBe('Runway is tight  this quarter.');
  });
});

describe('cash flow end-to-end pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces cash flow in prompt and metadata without leaking row labels', async () => {
    // Monthly nets: Jan -7000, Feb -3000, Mar -1000. Median = -3000, direction burning, monthsBurning 3.
    // Every row carries an identifiable label — the privacy check greps for these exact strings below.
    const burningRows = [
      { id: 100, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-01-01'), amount: '10000.00', label: 'Acme Corp invoice #4218',  metadata: null, createdAt: new Date() },
      { id: 101, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-01-01'), amount: '7000.00',  label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
      { id: 102, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Payroll', parentCategory: 'Expenses', date: new Date('2026-01-01'), amount: '10000.00', label: 'Gusto payroll batch #JK2', metadata: null, createdAt: new Date() },
      { id: 103, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-02-01'), amount: '10000.00', label: 'Widget sales Feb',         metadata: null, createdAt: new Date() },
      { id: 104, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-02-01'), amount: '7000.00',  label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
      { id: 105, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Payroll', parentCategory: 'Expenses', date: new Date('2026-02-01'), amount: '6000.00',  label: 'Gusto payroll batch #JK3', metadata: null, createdAt: new Date() },
      { id: 106, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-03-01'), amount: '10000.00', label: 'Widget sales Mar',         metadata: null, createdAt: new Date() },
      { id: 107, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-03-01'), amount: '7000.00',  label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
      { id: 108, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Payroll', parentCategory: 'Expenses', date: new Date('2026-03-01'), amount: '4000.00',  label: 'Gusto payroll batch #JK4', metadata: null, createdAt: new Date() },
    ];

    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(burningRows as never);

    const insights = await runCurationPipeline(1, 1);
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(insights);

    // metadata: cash_flow present, prompt version bumped
    expect(result.metadata.statTypes).toContain('cash_flow');
    expect(result.metadata.promptVersion).toBe('v1.5');

    // prompt: cash flow framing with signed monthly net
    expect(result.prompt).toMatch(/Cash Flow: burning/);
    expect(result.prompt).toMatch(/-\$[\d,]+\/mo/);
    expect(result.prompt).toMatch(/over 3 months/);

    // privacy boundary: no row-level labels survive assembly
    const sensitiveLabels = [
      'Acme Corp invoice #4218',
      'Main St landlord wire',
      'Gusto payroll batch #JK2',
      'Gusto payroll batch #JK3',
      'Gusto payroll batch #JK4',
      'Widget sales Feb',
      'Widget sales Mar',
    ];
    for (const label of sensitiveLabels) {
      expect(result.prompt).not.toContain(label);
    }
  });
});

describe('runway end-to-end pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces runway in prompt and metadata when cash balance is fresh', async () => {
    const now = new Date('2026-04-20T00:00:00.000Z');
    const cashAsOfDate = new Date('2026-04-10T00:00:00.000Z').toISOString();

    // Burning business: 5k/mo net loss over 3 months. Cash = 15000 → ~3.0 months runway.
    const burningRows = [
      { id: 200, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-02-01'), amount: '10000.00', label: 'Acme Corp invoice #4218',  metadata: null, createdAt: new Date() },
      { id: 201, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-02-01'), amount: '15000.00', label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
      { id: 202, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-03-01'), amount: '10000.00', label: 'Widget sales Mar',         metadata: null, createdAt: new Date() },
      { id: 203, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-03-01'), amount: '15000.00', label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
      { id: 204, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-04-01'), amount: '10000.00', label: 'Widget sales Apr',         metadata: null, createdAt: new Date() },
      { id: 205, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-04-01'), amount: '15000.00', label: 'Main St landlord wire',    metadata: null, createdAt: new Date() },
    ];

    vi.mocked(dataRowsQueries.getRowsByDataset).mockResolvedValue(burningRows as never);

    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { assemblePrompt } = await import('./assembly.js');

    const stats = computeStats(burningRows as never, {
      financials: { cashOnHand: 15000, cashAsOfDate },
      now,
    });
    const insights = scoreInsights(stats);
    const result = assemblePrompt(insights);

    expect(result.metadata.statTypes).toContain('runway');
    expect(result.metadata.promptVersion).toBe('v1.5');
    expect(result.prompt).toMatch(/Runway:\s+3\.0\s+months/);
    expect(result.prompt).toContain('cash $15,000');
    expect(result.prompt).toContain('as of 2026-04-10');
    expect(result.prompt).toContain('confidence: high');

    // Privacy regression guard — no row labels leak into runway framing
    for (const label of ['Acme Corp invoice #4218', 'Main St landlord wire', 'Widget sales Mar', 'Widget sales Apr']) {
      expect(result.prompt).not.toContain(label);
    }
  });

  it('low-confidence runway when cash balance is 100 days old', async () => {
    const now = new Date('2026-04-20T00:00:00.000Z');
    const staleDate = new Date(now);
    staleDate.setUTCDate(staleDate.getUTCDate() - 100);

    const burningRows = [
      { id: 300, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-02-01'), amount: '10000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 301, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-02-01'), amount: '15000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 302, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-03-01'), amount: '10000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 303, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-03-01'), amount: '15000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 304, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-04-01'), amount: '10000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 305, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-04-01'), amount: '15000.00', label: null, metadata: null, createdAt: new Date() },
    ];

    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { assemblePrompt } = await import('./assembly.js');

    const stats = computeStats(burningRows as never, {
      financials: { cashOnHand: 15000, cashAsOfDate: staleDate.toISOString() },
      now,
    });
    const insights = scoreInsights(stats);
    const result = assemblePrompt(insights);

    expect(result.prompt).toContain('confidence: low');
  });
});

describe('break-even end-to-end pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces break-even in prompt and metadata when fixed costs are set', async () => {
    // 6 months of data: revenue 50k, expenses 40k → margin 20%.
    // monthlyFixedCosts 15k → break-even 75k. Current revenue 50k → gap 25k.
    const burningRows = [
      { id: 400, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-01-15'), amount: '50000.00', label: 'Acme Corp invoice #4218', metadata: null, createdAt: new Date() },
      { id: 401, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-01-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
      { id: 402, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-02-15'), amount: '50000.00', label: 'Widget sales Feb',        metadata: null, createdAt: new Date() },
      { id: 403, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-02-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
      { id: 404, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-03-15'), amount: '50000.00', label: 'Widget sales Mar',        metadata: null, createdAt: new Date() },
      { id: 405, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-03-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
      { id: 406, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-04-15'), amount: '50000.00', label: 'Widget sales Apr',        metadata: null, createdAt: new Date() },
      { id: 407, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-04-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
      { id: 408, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-05-15'), amount: '50000.00', label: 'Widget sales May',        metadata: null, createdAt: new Date() },
      { id: 409, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-05-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
      { id: 410, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-06-15'), amount: '50000.00', label: 'Widget sales Jun',        metadata: null, createdAt: new Date() },
      { id: 411, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-06-15'), amount: '40000.00', label: 'Main St landlord wire',   metadata: null, createdAt: new Date() },
    ];

    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { assemblePrompt } = await import('./assembly.js');

    const stats = computeStats(burningRows as never, {
      financials: { monthlyFixedCosts: 15_000 },
    });
    const insights = scoreInsights(stats);
    const result = assemblePrompt(insights);

    expect(result.metadata.statTypes).toContain('break_even');
    expect(result.metadata.promptVersion).toBe('v1.5');
    expect(result.prompt).toMatch(/Break-Even:\s+\$75,000\/mo/);
    expect(result.prompt).toMatch(/at 20\.0% margin/);
    expect(result.prompt).toMatch(/gap \$25,000/);

    // Privacy regression guard — no row labels leak into break-even framing
    for (const label of ['Acme Corp invoice #4218', 'Main St landlord wire', 'Widget sales Mar', 'Widget sales Apr']) {
      expect(result.prompt).not.toContain(label);
    }
  });

  it('above-break-even fixture: reassuring negative gap without prescriptive framing', async () => {
    // Same margin (20%), same fixed costs (15k), but revenue 100k — well above break-even.
    // Expected: break-even 75k, gap -25k.
    const healthyRows = [
      { id: 500, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-01-15'), amount: '100000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 501, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-01-15'), amount: '80000.00',  label: null, metadata: null, createdAt: new Date() },
      { id: 502, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-02-15'), amount: '100000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 503, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-02-15'), amount: '80000.00',  label: null, metadata: null, createdAt: new Date() },
      { id: 504, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-03-15'), amount: '100000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 505, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-03-15'), amount: '80000.00',  label: null, metadata: null, createdAt: new Date() },
      { id: 506, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Revenue', parentCategory: 'Income',   date: new Date('2026-04-15'), amount: '100000.00', label: null, metadata: null, createdAt: new Date() },
      { id: 507, orgId: 1, datasetId: 1, sourceType: 'csv', category: 'Rent',    parentCategory: 'Expenses', date: new Date('2026-04-15'), amount: '80000.00',  label: null, metadata: null, createdAt: new Date() },
    ];

    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { assemblePrompt } = await import('./assembly.js');

    const stats = computeStats(healthyRows as never, {
      financials: { monthlyFixedCosts: 15_000 },
    });
    const insights = scoreInsights(stats);
    const result = assemblePrompt(insights);

    expect(result.metadata.statTypes).toContain('break_even');
    expect(result.prompt).toMatch(/Break-Even:\s+\$75,000\/mo/);
    // Gap is negative — prompt should render the minus sign explicitly.
    expect(result.prompt).toMatch(/gap -\$25,000/);
  });
});

describe('chart-tag pipeline integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('assembles a prompt with the stat-ID allowlist injected', async () => {
    const { readFileSync } = await import('node:fs');
    // path-aware mock — scoring config still loads JSON, prompt-template
    // calls return the allowlist-aware mock
    vi.mocked(readFileSync).mockImplementation((...args: unknown[]) => {
      const p = String(args[0]);
      if (p.includes('prompt-templates')) {
        return 'Allowlist: {{allowedStatIds}}\nStats:\n{{statSummaries}}\n';
      }
      return JSON.stringify({
        version: '1.0',
        topN: 8,
        weights: { novelty: 0.35, actionability: 0.4, specificity: 0.25 },
        thresholds: { anomalyZScore: 2.0, trendMinDataPoints: 3, significantChangePercent: 10 },
      });
    });

    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { assemblePrompt } = await import('./assembly.js');

    const stats = computeStats(fixtureRows as never);
    const insights = scoreInsights(stats);
    const result = assemblePrompt(insights, 'v2');

    expect(result.prompt).toMatch(/Allowlist: [a-z_, ]+/);
    const allowlistMatch = result.prompt.match(/Allowlist: ([a-z_, ]+)/);
    expect(allowlistMatch).not.toBeNull();
    const advertised = allowlistMatch![1]!.split(', ').sort();
    expect(advertised).toEqual([...result.metadata.statTypes].sort());
  });

  it('validateStatRefs rejects unknown IDs and accepts mapped ones together', async () => {
    const { computeStats } = await import('./computation.js');
    const { scoreInsights } = await import('./scoring.js');
    const { validateStatRefs } = await import('./validator.js');

    const stats = computeStats(fixtureRows as never);
    const insights = scoreInsights(stats);
    const allowedIds = [...new Set(insights.map((i) => i.stat.statType))];

    // simulate an LLM output with one valid ID and one hallucinated ID
    const validId = allowedIds[0]!;
    const fakeSummary = `First paragraph <stat id="${validId}"/> grounded.\n\nSecond <stat id="runaway"/> hallucinated.`;

    const report = validateStatRefs(fakeSummary, insights.map((i) => i.stat));
    expect(report.invalidRefs).toEqual(['runaway']);
  });

  it('stripInvalidStatRefs preserves valid tags for downstream binding', async () => {
    const { stripInvalidStatRefs } = await import('./validator.js');

    const summary = '<stat id="runway"/> kept and <stat id="ghost"/> stripped.';
    const cleaned = stripInvalidStatRefs(summary, ['ghost']);

    expect(cleaned).toBe('<stat id="runway"/> kept and  stripped.');
  });
});
