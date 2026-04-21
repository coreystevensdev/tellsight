import { describe, it, expect } from 'vitest';
import { STAT_CHART_MAP, getStatChartConfig } from './statChartMap';

describe('statChartMap', () => {
  it('maps every advertised stat ID to a config with label + component name', () => {
    for (const [id, cfg] of Object.entries(STAT_CHART_MAP)) {
      expect(cfg.label, `${id} missing label`).toBeTruthy();
      expect(cfg.thumbnailComponent, `${id} missing thumbnailComponent`).toBeTruthy();
    }
  });

  it('returns config for known stat IDs', () => {
    expect(getStatChartConfig('runway')).toEqual({
      label: 'Cash balance over time',
      thumbnailComponent: 'RunwayTrendChart',
    });
  });

  it('returns null for unmapped stat IDs (text-only stats)', () => {
    expect(getStatChartConfig('total')).toBeNull();
    expect(getStatChartConfig('average')).toBeNull();
    expect(getStatChartConfig('anomaly')).toBeNull();
    expect(getStatChartConfig('category_breakdown')).toBeNull();
    expect(getStatChartConfig('seasonal_projection')).toBeNull();
  });

  it('returns null for unknown stat IDs (defensive against typos)', () => {
    expect(getStatChartConfig('runaway')).toBeNull();
    expect(getStatChartConfig('')).toBeNull();
  });
});
