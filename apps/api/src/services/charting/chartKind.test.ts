import { describe, it, expect } from 'vitest';

import { getChartKindForRuleKind } from './chartKind.js';

describe('getChartKindForRuleKind', () => {
  it('maps runway_runs_short to runway', () => {
    expect(getChartKindForRuleKind('runway_runs_short')).toBe('runway');
  });

  it('maps cash_burn_spikes to cash-flow', () => {
    expect(getChartKindForRuleKind('cash_burn_spikes')).toBe('cash-flow');
  });

  it('maps margin_drops to margin', () => {
    expect(getChartKindForRuleKind('margin_drops')).toBe('margin');
  });

  it('has no chart for breakeven_gap_widens', () => {
    expect(getChartKindForRuleKind('breakeven_gap_widens')).toBeNull();
  });

  it('has no chart for anomaly_fires', () => {
    expect(getChartKindForRuleKind('anomaly_fires')).toBeNull();
  });
});
