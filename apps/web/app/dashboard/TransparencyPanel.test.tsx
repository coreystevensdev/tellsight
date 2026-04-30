import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { TransparencyPanel } from './TransparencyPanel';
import type { TransparencyMetadata } from 'shared/types';

const metadata: TransparencyMetadata = {
  statTypes: ['trend', 'anomaly', 'category_breakdown'],
  categoryCount: 5,
  insightCount: 3,
  scoringWeights: { novelty: 0.4, actionability: 0.35, specificity: 0.25 },
  promptVersion: 'v1',
  generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

afterEach(cleanup);

describe('TransparencyPanel', () => {
  it('returns null when isOpen is false', () => {
    const { container } = render(
      <TransparencyPanel metadata={metadata} isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('returns null when metadata is null', () => {
    const { container } = render(
      <TransparencyPanel metadata={null} isOpen={true} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders methodology content from metadata', () => {
    render(<TransparencyPanel metadata={metadata} isOpen={true} onClose={vi.fn()} />);

    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText('How I reached this conclusion')).toBeTruthy();
    expect(within(panel).getByText('Trend analysis')).toBeTruthy();
    expect(within(panel).getByText('Anomaly detection')).toBeTruthy();
    expect(within(panel).getByText('Category breakdown')).toBeTruthy();
    expect(within(panel).getByText('3 key insights from 5 categories')).toBeTruthy();
    expect(within(panel).getByText('v1')).toBeTruthy();
  });

  it('renders scoring weights as percentages', () => {
    render(<TransparencyPanel metadata={metadata} isOpen={true} onClose={vi.fn()} />);

    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText('40%')).toBeTruthy();
    expect(within(panel).getByText('35%')).toBeTruthy();
    expect(within(panel).getByText('25%')).toBeTruthy();
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    render(<TransparencyPanel metadata={metadata} isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText('Close transparency panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape key closes panel', () => {
    const onClose = vi.fn();
    render(<TransparencyPanel metadata={metadata} isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has correct aria attributes', () => {
    render(<TransparencyPanel metadata={metadata} isOpen={true} onClose={vi.fn()} />);

    const panel = screen.getByRole('complementary');
    expect(panel.getAttribute('aria-label')).toBe('AI analysis methodology');
    expect(panel.getAttribute('aria-live')).toBe('polite');
  });

  it('renders stat types as badges with human-readable labels', () => {
    const customMeta = { ...metadata, statTypes: ['total', 'average'] };
    render(<TransparencyPanel metadata={customMeta} isOpen={true} onClose={vi.fn()} />);

    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText('Total analysis')).toBeTruthy();
    expect(within(panel).getByText('Average computation')).toBeTruthy();
  });

  it('falls back to raw stat type name for unknown types', () => {
    const customMeta = { ...metadata, statTypes: ['custom_stat'] };
    render(<TransparencyPanel metadata={customMeta} isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('custom_stat')).toBeTruthy();
  });

  it('renders humanized labels for cash_flow and runway (regression guard)', () => {
    const customMeta = { ...metadata, statTypes: ['cash_flow', 'runway'] };
    render(<TransparencyPanel metadata={customMeta} isOpen={true} onClose={vi.fn()} />);

    const panel = screen.getByRole('complementary');
    // If STAT_TYPE_LABELS loses either entry, the raw snake_case key would render
    // instead, bug Story 8.1 caught for cash_flow, Story 8.2 for runway.
    expect(within(panel).getByText('Cash Flow')).toBeTruthy();
    expect(within(panel).getByText('Runway')).toBeTruthy();
    expect(within(panel).queryByText('cash_flow')).toBeNull();
    expect(within(panel).queryByText('runway')).toBeNull();
  });
});
