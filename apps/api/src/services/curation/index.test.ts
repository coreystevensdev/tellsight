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
      expect.objectContaining({ promptVersion: 'v1', insightCount: expect.any(Number) }),
      'v1',
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
});
