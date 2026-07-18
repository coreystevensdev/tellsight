import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const context = { correlationId: 'corr-1', orgId: 42, ruleId: 7 };
const MAX_PNG_BYTES = 80 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const runwayData = { cashOnHand: 10_000, monthlyNet: -2_500, runwayMonths: 4 };
const cashFlowData = {
  recentMonths: [
    { month: 'Jan', revenue: 42_000, expenses: 38_000 },
    { month: 'Feb', revenue: 45_000, expenses: 41_000 },
    { month: 'Mar', revenue: 39_000, expenses: 44_000 },
    { month: 'Apr', revenue: 47_000, expenses: 43_000 },
  ],
};
const marginData = { recentMarginPercent: 12, priorMarginPercent: 22, direction: 'shrinking' as const };

describe('renderChart (real pipeline, per the compatibility spike)', () => {
  // First real render in the process pays for jsdom + Resvg's system-font
  // scan; that cold cost is a one-time thing per worker, not per alert, but
  // it's slow enough here to need headroom over vitest's 5s default.
  it('renders a runway chart to a PNG under the size budget', async () => {
    const { renderChart } = await import('./renderChart.js');
    const png = await renderChart({ chartKind: 'runway', data: runwayData }, context);

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png!.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
  }, 20_000);

  it('renders a cash-flow chart to a PNG under the size budget', async () => {
    const { renderChart } = await import('./renderChart.js');
    const png = await renderChart({ chartKind: 'cash-flow', data: cashFlowData }, context);

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png!.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
  }, 20_000);

  it('renders a margin chart to a PNG under the size budget', async () => {
    const { renderChart } = await import('./renderChart.js');
    const png = await renderChart({ chartKind: 'margin', data: marginData }, context);

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png!.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
  }, 20_000);
});

describe('buildRunwayPoints', () => {
  it('projects a straight decline to zero over ceil(runwayMonths)', async () => {
    const { buildRunwayPoints } = await import('./renderChart.js');
    const points = buildRunwayPoints({ cashOnHand: 10_000, monthlyNet: -2_500, runwayMonths: 4 });

    expect(points).toHaveLength(5); // month 0..4
    expect(points[0]).toEqual({ label: 'Today', balance: 10_000 });
    expect(points[4]).toEqual({ label: 'Month 4', balance: 0 });
  });

  it('rounds a fractional runway up so the line reaches zero', async () => {
    const { buildRunwayPoints } = await import('./renderChart.js');
    const points = buildRunwayPoints({ cashOnHand: 10_000, monthlyNet: -4_000, runwayMonths: 2.5 });

    expect(points).toHaveLength(4); // ceil(2.5) = 3, month 0..3
    expect(points[3]!.balance).toBe(0);
  });

  it('clamps balance at zero, never goes negative', async () => {
    const { buildRunwayPoints } = await import('./renderChart.js');
    const points = buildRunwayPoints({ cashOnHand: 1_000, monthlyNet: -2_000, runwayMonths: 0.5 });

    for (const p of points) {
      expect(p.balance).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildCashFlowPoints', () => {
  it('passes month/revenue/expenses through unchanged', async () => {
    const { buildCashFlowPoints } = await import('./renderChart.js');
    const points = buildCashFlowPoints(cashFlowData);

    expect(points).toEqual([
      { month: 'Jan', revenue: 42_000, expenses: 38_000 },
      { month: 'Feb', revenue: 45_000, expenses: 41_000 },
      { month: 'Mar', revenue: 39_000, expenses: 44_000 },
      { month: 'Apr', revenue: 47_000, expenses: 43_000 },
    ]);
  });
});

describe('buildMarginPoints', () => {
  it('builds a two-point prior/recent series', async () => {
    const { buildMarginPoints } = await import('./renderChart.js');
    const points = buildMarginPoints(marginData);

    expect(points).toEqual([
      { label: 'Prior period', marginPercent: 22 },
      { label: 'Recent period', marginPercent: 12 },
    ]);
  });
});

describe('renderChart degrade paths (I/O matrix)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@resvg/resvg-js');
    vi.doUnmock('sharp');
  });

  it('returns null and logs a warning when Resvg fails to parse the chart SVG', async () => {
    vi.doMock('@resvg/resvg-js', () => ({
      Resvg: class {
        constructor() {
          throw new Error('SVG data parsing failed');
        }
      },
    }));

    const { renderChart } = await import('./renderChart.js');
    const { logger } = await import('../../lib/logger.js');

    const png = await renderChart({ chartKind: 'runway', data: runwayData }, context);

    expect(png).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', orgId: 42, ruleId: 7, chartKind: 'runway' }),
      expect.stringContaining('Resvg failed to parse'),
    );
  });

  it('retries once at a lower quality tier, then degrades to null if still over budget', async () => {
    const toBuffer = vi.fn().mockResolvedValue(Buffer.alloc(90 * 1024, 1));
    const pngFn = vi.fn((_opts: { quality: number; compressionLevel: number }) => ({ toBuffer }));
    const sharpFn = vi.fn(() => ({ png: pngFn }));
    vi.doMock('sharp', () => ({ default: sharpFn }));

    const { renderChart } = await import('./renderChart.js');
    const { logger } = await import('../../lib/logger.js');

    const png = await renderChart({ chartKind: 'runway', data: runwayData }, context);

    expect(png).toBeNull();
    expect(pngFn).toHaveBeenCalledTimes(2);
    expect(pngFn.mock.calls[0]![0]).toMatchObject({ quality: 80 });
    expect(pngFn.mock.calls[1]![0]).toMatchObject({ quality: 50 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', orgId: 42, ruleId: 7, chartKind: 'runway' }),
      expect.stringContaining('exceeds the size budget'),
    );
  });

  it('returns null and logs a warning when Sharp throws mid-optimize', async () => {
    const toBuffer = vi.fn().mockRejectedValue(new Error('libvips encode failure'));
    const pngFn = vi.fn(() => ({ toBuffer }));
    const sharpFn = vi.fn(() => ({ png: pngFn }));
    vi.doMock('sharp', () => ({ default: sharpFn }));

    const { renderChart } = await import('./renderChart.js');
    const { logger } = await import('../../lib/logger.js');

    const png = await renderChart({ chartKind: 'runway', data: runwayData }, context);

    expect(png).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', orgId: 42, ruleId: 7, chartKind: 'runway' }),
      expect.stringContaining('Sharp failed to optimize'),
    );
  });
});
