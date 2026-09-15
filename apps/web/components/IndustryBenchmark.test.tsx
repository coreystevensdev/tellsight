import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { IndustryBenchmark } from './IndustryBenchmark';

afterEach(cleanup);

describe('IndustryBenchmark', () => {
  it('shows the sector and both figures for a mapped business type', () => {
    render(<IndustryBenchmark businessType="restaurant" />);

    expect(screen.getByText(/Restaurants \(full & limited service\)/)).toBeInTheDocument();
    expect(screen.getByText('3.4%')).toBeInTheDocument();
    expect(screen.getByText('18.8%')).toBeInTheDocument();
  });

  // Every figure here is someone else's, so the citation is not decoration. A
  // number on screen with no way back to its source is the thing this whole
  // feature was supposed to avoid.
  it('cites the source and links to the published file', () => {
    render(<IndustryBenchmark businessType="retail" />);

    expect(screen.getByText(/IRS Statistics of Income/)).toBeInTheDocument();
    expect(screen.getByText(/tax year 2023/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /source data/i }).getAttribute('href'))
      .toMatch(/^https:\/\/www\.irs\.gov\//);
  });

  // The reason the figures can ship at all. SOI net income still contains the
  // owner's own pay, and a reader who does not know that will draw the wrong
  // conclusion from a single glance.
  it('shows the owner-compensation caveat', () => {
    render(<IndustryBenchmark businessType="construction" />);
    expect(screen.getByText(/do not pay themselves a salary/i)).toBeInTheDocument();
  });

  // The reason the second source exists. A business with employees is almost
  // certainly an S-corp, whose owner salary is already deducted, so showing it
  // the sole-proprietor figure tells it something untrue about itself.
  it.each(['2_5', '6_20', 'over_20'] as const)(
    'reads the employer table when teamSize is %s',
    (teamSize) => {
      render(<IndustryBenchmark businessType="services" teamSize={teamSize} />);

      expect(screen.getByText('12.9%')).toBeInTheDocument();
      expect(screen.getByText(/Table 6.1/)).toBeInTheDocument();
      expect(screen.getByText(/already deducted/i)).toBeInTheDocument();
    },
  );

  it('reads the sole-proprietor table for a one-person business', () => {
    render(<IndustryBenchmark businessType="services" teamSize="solo" />);

    expect(screen.getByText('39.7%')).toBeInTheDocument();
    expect(screen.getByText(/do not pay themselves a salary/i)).toBeInTheDocument();
  });

  // A missing answer is not evidence of employees, and this was the behaviour
  // before the split, so an unknown teamSize must not silently change what an
  // existing user sees.
  it('keeps the sole-proprietor table when teamSize is unknown', () => {
    render(<IndustryBenchmark businessType="services" teamSize={null} />);

    expect(screen.getByText('39.7%')).toBeInTheDocument();
  });

  // SOI cannot separate technology from professional services, so there is no
  // figure to show. Rendering nothing is the point: the alternative is showing
  // the services number under a technology label.
  it('renders nothing for a business type the source cannot distinguish', () => {
    const { container } = render(<IndustryBenchmark businessType="technology" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before onboarding has recorded a business type', () => {
    const { container } = render(<IndustryBenchmark businessType={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // No arrow, no "above"/"below", no verdict of any kind. Tellsight cannot see
  // whether a user books owner draw as an expense, so any comparison it drew
  // would be against a number that is not measuring the same thing.
  it('states no comparison against the reader', () => {
    render(<IndustryBenchmark businessType="healthcare" />);
    const text = screen.getByRole('region').textContent ?? '';
    expect(text).not.toMatch(/\byour margin\b|above average|below average|you are|better than|worse than/i);
  });
});
