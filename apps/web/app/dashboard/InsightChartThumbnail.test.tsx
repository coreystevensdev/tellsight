import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InsightChartThumbnail } from './InsightChartThumbnail';

describe('InsightChartThumbnail', () => {
  it('returns null for unmapped stat IDs', () => {
    const { container } = render(<InsightChartThumbnail statId="anomaly" onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a button with accessible name for mapped stat IDs', () => {
    render(<InsightChartThumbnail statId="cash_flow" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /open revenue vs\. expenses drill-down/i })).toBeInTheDocument();
  });

  it('fires onOpen when activated', () => {
    const onOpen = vi.fn();
    render(<InsightChartThumbnail statId="margin_trend" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the runway sparkline when cashHistory has 2+ points', () => {
    render(
      <InsightChartThumbnail
        statId="runway"
        onOpen={() => {}}
        cashHistory={[
          { balance: 12000, asOfDate: '2026-04-01T00:00:00Z' },
          { balance: 9500, asOfDate: '2026-03-01T00:00:00Z' },
        ]}
      />,
    );
    // role=img label inside RunwayTrendChart thumbnail variant
    expect(screen.getByRole('img', { name: /cash balance over time/i })).toBeInTheDocument();
  });

  it('delegates empty-state rendering to RunwayTrendChart for runway with no data', () => {
    // cashHistory=[] + no forecast → RunwayTrendChart renders its own
    // "more history needed" placeholder. Verifies the delegation, not
    // a thumbnail-local fallback string.
    render(<InsightChartThumbnail statId="runway" onOpen={() => {}} cashHistory={[]} />);
    expect(screen.getByText(/more history needed/i)).toBeInTheDocument();
  });

  it('renders the generic "Tap to open chart" affordance for mapped stats without dedicated thumbnail data', () => {
    // statId='trend' maps to RevenueChart but the thumbnail doesn't have a
    // lightweight variant for it, so the branch at InsightChartThumbnail.tsx
    // falls through to the affordance text.
    render(<InsightChartThumbnail statId="trend" onOpen={() => {}} />);
    expect(screen.getByText(/tap to open chart/i)).toBeInTheDocument();
  });

  it('renders the combined chart for cash_forecast when forecast is present', () => {
    render(
      <InsightChartThumbnail
        statId="cash_forecast"
        onOpen={() => {}}
        cashHistory={[
          { balance: 40_000, asOfDate: '2026-06-01T00:00:00Z' },
          { balance: 35_000, asOfDate: '2026-05-01T00:00:00Z' },
        ]}
        cashForecast={[
          { balance: 30_000, asOfDate: '2026-07-01' },
          { balance: 20_000, asOfDate: '2026-08-01' },
          { balance: 10_000, asOfDate: '2026-09-01' },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: /cash balance/i })).toBeInTheDocument();
  });

  it('renders a forecast-only chart when cashHistory is empty but forecast has points', () => {
    render(
      <InsightChartThumbnail
        statId="cash_forecast"
        onOpen={() => {}}
        cashHistory={[{ balance: 40_000, asOfDate: '2026-06-01T00:00:00Z' }]}
        cashForecast={[
          { balance: 30_000, asOfDate: '2026-07-01' },
          { balance: 20_000, asOfDate: '2026-08-01' },
          { balance: 10_000, asOfDate: '2026-09-01' },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: /cash balance/i })).toBeInTheDocument();
  });
});
