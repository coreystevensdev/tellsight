import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlertsCompliancePanel } from './AlertsCompliancePanel';
import type { AlertComplianceMetrics } from './types';

const baseMetrics: AlertComplianceMetrics = {
  totalRules: 12,
  mutedRules: 2,
  d7: { fired: 5, quotaSuppressed: 1 },
  d30: { fired: 20, quotaSuppressed: 4 },
  byRuleKind: [
    { ruleKind: 'runway_runs_short', totalRules: 4, fired: 8, clicked: 2, candidateDefaultOffRules: 1 },
    { ruleKind: 'margin_drops', totalRules: 3, fired: 0, clicked: 0, candidateDefaultOffRules: 0 },
  ],
  computedAt: '2026-07-18T12:00:00.000Z',
};

const zeroActivity: AlertComplianceMetrics = {
  totalRules: 0,
  mutedRules: 0,
  d7: { fired: 0, quotaSuppressed: 0 },
  d30: { fired: 0, quotaSuppressed: 0 },
  byRuleKind: [
    { ruleKind: 'runway_runs_short', totalRules: 0, fired: 0, clicked: 0, candidateDefaultOffRules: 0 },
  ],
  computedAt: '2026-07-18T12:00:00.000Z',
};

describe('AlertsCompliancePanel', () => {
  it('renders an unavailable state when metrics is null', () => {
    render(<AlertsCompliancePanel metrics={null} />);

    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText(/metrics unavailable/i)).toBeInTheDocument();
  });

  it('renders total rules, muted rate, and the 7d/30d fired and suppressed windows', () => {
    render(<AlertsCompliancePanel metrics={baseMetrics} />);

    expect(screen.getByText('Total rules')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // 2/12 muted
    expect(screen.getByText(/16\.7% \(2 of 12\)/)).toBeInTheDocument();

    expect(screen.getByText('Fired (7d)')).toBeInTheDocument();
    expect(screen.getByText('Fired (30d)')).toBeInTheDocument();
    // 1/(5+1) quota-suppressed 7d
    expect(screen.getByText(/16\.7% \(1 of 6\)/)).toBeInTheDocument();
  });

  it('renders a row per rule kind with click rate and the candidate-default-off badge', () => {
    render(<AlertsCompliancePanel metrics={baseMetrics} />);

    expect(screen.getByText('cash runway')).toBeInTheDocument();
    expect(screen.getByText('profit margin')).toBeInTheDocument();
    // 2/8 clicked for runway
    expect(screen.getByText(/25\.0% \(2 of 8\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 candidate for default-off/)).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('renders n/a placeholders with no divide-by-zero when there is no alert activity', () => {
    render(<AlertsCompliancePanel metrics={zeroActivity} />);

    const placeholders = screen.getAllByText(/n\/a \(0 of 0\)/);
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
  });
});
