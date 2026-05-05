import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  InvoiceFlowCard,
  INVOICEFLOW_CARD_HEADING,
  INVOICEFLOW_CARD_BODY,
} from './InvoiceFlowCard';
import { INVOICEFLOW_URL } from '@/lib/site-links';

describe('InvoiceFlowCard', () => {
  it('renders the locked heading and body verbatim', () => {
    render(<InvoiceFlowCard />);

    expect(
      screen.getByRole('heading', { name: INVOICEFLOW_CARD_HEADING }),
    ).toBeInTheDocument();
    expect(screen.getByText(INVOICEFLOW_CARD_BODY)).toBeInTheDocument();
  });

  it('exposes the card as a complementary landmark labeled by its heading', () => {
    render(<InvoiceFlowCard />);

    expect(
      screen.getByRole('complementary', { name: INVOICEFLOW_CARD_HEADING }),
    ).toBeInTheDocument();
  });

  it('renders an external link to InvoiceFlow with safe attributes', () => {
    render(<InvoiceFlowCard />);

    const link = screen.getByRole('link', { name: /open invoiceflow/i });
    expect(link).toHaveAttribute('href', INVOICEFLOW_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel') ?? '').toContain('noopener');
  });
});
