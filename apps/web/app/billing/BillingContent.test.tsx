import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// No test file, and no reference from any other test. This is the only path a
// user has to start paying or to change a card, and both halves redirect to
// Stripe using a URL that comes back in the response body.

const useSubscription = vi.fn();
vi.mock('@/lib/hooks/useSubscription', () => ({
  useSubscription: (...args: unknown[]) => useSubscription(...args),
}));

import { BillingContent } from './BillingContent';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  useSubscription.mockReturnValue({ tier: 'free', isLoading: false });
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
    configurable: true,
  });
});

describe('BillingContent tier affordances', () => {
  it('offers checkout on the free tier', () => {
    render(<BillingContent />);

    expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage Subscription/ })).not.toBeInTheDocument();
  });

  // Showing "Upgrade" to someone already paying would take a second payment.
  it('offers the portal on the pro tier, not checkout', () => {
    useSubscription.mockReturnValue({ tier: 'pro', isLoading: false });

    render(<BillingContent />);

    expect(screen.getByRole('button', { name: /Manage Subscription/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade to Pro/ })).not.toBeInTheDocument();
  });
});

describe('BillingContent checkout', () => {
  it('redirects to the checkout URL the API returns', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1' } }));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    await waitFor(() => expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_1'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/subscriptions?action=checkout');
  });

  // The early return matters: without it the handler falls through and assigns
  // undefined to location.href, navigating the user to a broken URL instead of
  // showing them why it failed.
  it('shows the API message and does not navigate when checkout fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'No payment method on file' } }, 402));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    expect(await screen.findByText('No payment method on file')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('falls back to a generic message when the API sends none', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    expect(await screen.findByText('Failed to start checkout')).toBeInTheDocument();
  });

  it('reports a network failure rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });

  // The finally block. Without it a failed attempt leaves the button disabled
  // and the user cannot retry.
  it('re-enables the button after a failure', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeEnabled());
  });
});

describe('BillingContent portal', () => {
  it('redirects to the portal URL the API returns', async () => {
    useSubscription.mockReturnValue({ tier: 'pro', isLoading: false });
    fetchMock.mockResolvedValueOnce(json({ data: { portalUrl: 'https://billing.stripe.com/p/session_1' } }));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Manage Subscription/ }));

    await waitFor(() => expect(window.location.href).toBe('https://billing.stripe.com/p/session_1'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/subscriptions?action=portal');
  });

  it('shows the API message and does not navigate when the portal fails', async () => {
    useSubscription.mockReturnValue({ tier: 'pro', isLoading: false });
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'No Stripe customer' } }, 400));

    const user = userEvent.setup();
    render(<BillingContent />);
    await user.click(screen.getByRole('button', { name: /Manage Subscription/ }));

    expect(await screen.findByText('No Stripe customer')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });
});
