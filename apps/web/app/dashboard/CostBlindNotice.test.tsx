import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CostBlindNotice, joinSources } from './CostBlindNotice';

// DW-279: a revenue-only connector produces a dashboard made of totals and
// averages with margin and break-even simply absent, and before this nothing
// said they were never computable. These tests pin the two properties that make
// the notice worth having: it appears exactly when the data cannot support
// those insights, and it cannot be made to go away.

describe('when it renders', () => {
  it('names the connector and what is missing', () => {
    render(<CostBlindNotice sources={['shopify']} />);

    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByText(/profit margin and break-even/i)).toBeInTheDocument();
    expect(screen.getByText(/Shopify reports money coming in/i)).toBeInTheDocument();
  });

  // The whole point of passing names rather than a boolean. "Some insights are
  // unavailable" is not something an owner can act on.
  it('offers both ways out of it', () => {
    render(<CostBlindNotice sources={['square']} />);

    expect(screen.getByRole('link', { name: /connect a source/i })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
    expect(screen.getByRole('link', { name: /upload a csv/i })).toHaveAttribute('href', '/upload');
  });

  it('reads as information rather than an error, because nothing is broken', () => {
    render(<CostBlindNotice sources={['shopify']} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * Not dismissible, deliberately, which is the opposite of
   * `DigestPausingBanner`. That warns about something that will happen and then
   * resolves; this is a standing property of the connector, so one dismiss
   * would restore the silence the notice exists to end, permanently.
   */
  it('has no dismiss control', () => {
    render(<CostBlindNotice sources={['shopify']} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/dismiss/i)).not.toBeInTheDocument();
  });
});

describe('when it stays out of the way', () => {
  // The common case by a wide margin: every production org with data has a CSV
  // dataset. A notice that showed up for them would be noise.
  it.each([[[] as string[]], [undefined]])('renders nothing for %o', (sources) => {
    const { container } = render(<CostBlindNotice sources={sources} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('joinSources', () => {
  it('reads as a sentence for one, two and three sources', () => {
    expect(joinSources(['shopify'])).toBe('Shopify');
    expect(joinSources(['shopify', 'square'])).toBe('Shopify and Square');
    expect(joinSources(['shopify', 'square', 'stripe'])).toBe('Shopify, Square and stripe');
  });

  // An unrecognised source falls through to its own name rather than being
  // dropped, so a connector added without a label still produces a sentence
  // that names something.
  it('falls back to the raw source name', () => {
    expect(joinSources(['paypal'])).toBe('paypal');
  });

  it('returns nothing for an empty list', () => {
    expect(joinSources([])).toBe('');
  });
});

describe('plural agreement', () => {
  it('conjugates for one source', () => {
    render(<CostBlindNotice sources={['shopify']} />);
    expect(screen.getByText(/Shopify reports money coming in/)).toBeInTheDocument();
  });

  it('conjugates for two', () => {
    render(<CostBlindNotice sources={['shopify', 'square']} />);
    expect(screen.getByText(/Shopify and Square report money coming in/)).toBeInTheDocument();
  });
});

/**
 * DW-288. The second half of the notice, rendered from its own prop so a source
 * that sees costs but names nobody gets the right paragraph instead of a
 * heading about margin.
 */
describe('the customer-concentration half', () => {
  it('explains the absence and names the source', () => {
    render(<CostBlindNotice sources={[]} anonymousSources={['shopify']} />);

    expect(screen.getByText(/Customer concentration needs a name/i)).toBeInTheDocument();
    expect(screen.getByText(/Shopify does not share who bought/i)).toBeInTheDocument();
  });

  // The case that justifies two independent sections rather than one block.
  // With only the anonymous list set, nothing about margin may appear.
  it('does not mention margin when only the name is missing', () => {
    render(<CostBlindNotice sources={[]} anonymousSources={['shopify']} />);

    expect(screen.queryByText(/Profit margin and break-even/i)).not.toBeInTheDocument();
  });

  it('does not mention concentration when only costs are missing', () => {
    render(<CostBlindNotice sources={['shopify']} anonymousSources={[]} />);

    expect(screen.getByText(/Profit margin and break-even/i)).toBeInTheDocument();
    expect(screen.queryByText(/Customer concentration/i)).not.toBeInTheDocument();
  });

  // Today's real case: Shopify is both, so both sections render together.
  it('shows both when the connector is blind in both ways', () => {
    render(<CostBlindNotice sources={['shopify']} anonymousSources={['shopify']} />);

    expect(screen.getByText(/Profit margin and break-even/i)).toBeInTheDocument();
    expect(screen.getByText(/Customer concentration needs a name/i)).toBeInTheDocument();
  });

  it('renders nothing when neither applies', () => {
    const { container } = render(<CostBlindNotice sources={[]} anonymousSources={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  // Omitting the new prop entirely has to behave exactly as before, since every
  // existing caller and the demo path pass only `sources`.
  it('behaves as it always did when the new prop is absent', () => {
    render(<CostBlindNotice sources={['square']} />);

    expect(screen.getByText(/Profit margin and break-even/i)).toBeInTheDocument();
    expect(screen.queryByText(/Customer concentration/i)).not.toBeInTheDocument();
  });
});
