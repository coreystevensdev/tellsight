import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InsightChartChip } from './InsightChartChip';

describe('InsightChartChip', () => {
  it('returns null for unmapped stat IDs', () => {
    const { container } = render(<InsightChartChip statId="total" onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the stat label inside an accessible button', () => {
    render(<InsightChartChip statId="runway" onOpen={() => {}} />);
    const btn = screen.getByRole('button', { name: /open cash balance over time drill-down/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/cash balance over time/i);
  });

  it('fires onOpen when activated', () => {
    const onOpen = vi.fn();
    render(<InsightChartChip statId="trend" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
