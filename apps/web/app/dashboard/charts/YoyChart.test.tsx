import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { YoyChart } from './YoyChart';
import type { YoyComparisonPoint } from 'shared/types';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const sampleData: YoyComparisonPoint[] = [
  { month: 'Jan', currentYear: 13440, priorYear: 12000, changePercent: 12, currentYearLabel: '2025', priorYearLabel: '2024' },
  { month: 'Feb', currentYear: 14054, priorYear: 12545, changePercent: 12, currentYearLabel: '2025', priorYearLabel: '2024' },
  { month: 'Mar', currentYear: 14669, priorYear: 13091, changePercent: 12.1, currentYearLabel: '2025', priorYearLabel: '2024' },
];

describe('YoyChart', () => {
  it('renders nothing when data is empty', () => {
    const { container } = render(<YoyChart data={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the chart with heading', () => {
    render(<YoyChart data={sampleData} />);
    expect(screen.getByText('Year-over-Year Revenue')).toBeInTheDocument();
  });

  it('renders as a figure with accessible label', () => {
    render(<YoyChart data={sampleData} />);
    const figure = screen.getByRole('figure');
    expect(figure).toBeInTheDocument();
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('aria-label', expect.stringContaining('2024'));
    expect(img).toHaveAttribute('aria-label', expect.stringContaining('2025'));
  });

  it('uses chart hover style without lift', () => {
    render(<YoyChart data={sampleData} />);
    const figure = screen.getByRole('figure');
    expect(figure.className).toContain('hover:border-primary');
    expect(figure.className).not.toContain('hover:-translate-y');
  });
});
