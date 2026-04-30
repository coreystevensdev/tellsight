import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import SharedInsightCard from './SharedInsightCard';
import ShareError from './ShareError';

afterEach(cleanup);

const baseProps = {
  orgName: 'Acme Corp',
  dateRange: 'Jan 2026, Mar 2026',
  aiSummaryContent: 'Revenue grew 12% quarter-over-quarter.\n\nExpenses remained stable with a slight decrease in marketing spend.',
};

describe('SharedInsightCard', () => {
  it('renders org name and date range', () => {
    render(<SharedInsightCard {...baseProps} />);

    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Jan 2026, Mar 2026')).toBeInTheDocument();
  });

  it('splits AI summary into paragraphs on double newline', () => {
    render(<SharedInsightCard {...baseProps} />);

    expect(screen.getByText(/Revenue grew 12%/)).toBeInTheDocument();
    expect(screen.getByText(/Expenses remained stable/)).toBeInTheDocument();

    // both rendered as <p> elements
    const revenue = screen.getByText(/Revenue grew 12%/);
    const expenses = screen.getByText(/Expenses remained stable/);
    expect(revenue.tagName).toBe('P');
    expect(expenses.tagName).toBe('P');
  });

  it('never renders sharer identity', () => {
    // no matter what props we pass, there's nowhere for identity to appear
    // the component doesn't accept sharer info at all (privacy-by-architecture)
    render(<SharedInsightCard {...baseProps} />);

    const container = screen.getByText('Acme Corp').closest('div')!;
    const text = container.textContent ?? '';
    expect(text).not.toContain('shared by');
    expect(text).not.toContain('Created by');
  });

  it('CTA links to /login with correct text', () => {
    render(<SharedInsightCard {...baseProps} />);

    const cta = screen.getByRole('link', { name: /insights like these/i });
    expect(cta).toHaveAttribute('href', '/login');
  });

  it('CTA has accessible touch target (48px height)', () => {
    render(<SharedInsightCard {...baseProps} />);

    const cta = screen.getByRole('link', { name: /insights like these/i });
    // h-12 = 3rem = 48px
    expect(cta.className).toContain('h-12');
  });

  it('CTA is full-width on mobile, auto on desktop', () => {
    render(<SharedInsightCard {...baseProps} />);

    const cta = screen.getByRole('link', { name: /insights like these/i });
    expect(cta.className).toContain('w-full');
    expect(cta.className).toContain('md:w-auto');
  });

  it('card container is max-w-2xl for desktop centering', () => {
    render(<SharedInsightCard {...baseProps} />);

    const wrapper = screen.getByText('Acme Corp').closest('[class*="max-w-2xl"]');
    expect(wrapper).toBeInTheDocument();
  });

  it('applies motion-reduce:duration-0 on wrapper', () => {
    render(<SharedInsightCard {...baseProps} />);

    const wrapper = screen.getByText('Acme Corp').closest('[class*="motion-reduce"]');
    expect(wrapper).toBeInTheDocument();
  });
});

describe('ShareError', () => {
  it('renders not-found variant correctly', () => {
    render(<ShareError variant="not-found" />);

    expect(screen.getByText("This shared insight doesn't exist")).toBeInTheDocument();
    expect(screen.getByText(/link may have been removed/i)).toBeInTheDocument();

    const homeLink = screen.getByRole('link', { name: /go to homepage/i });
    expect(homeLink).toHaveAttribute('href', '/');
  });

  it('renders expired variant correctly', () => {
    render(<ShareError variant="expired" />);

    expect(screen.getByText('This shared insight has expired')).toBeInTheDocument();
    expect(screen.getByText(/available for a limited time/i)).toBeInTheDocument();

    const homeLink = screen.getByRole('link', { name: /go to homepage/i });
    expect(homeLink).toHaveAttribute('href', '/');
  });
});
