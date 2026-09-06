import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 325 lines with no test file and no reference from any other test. The load
// path in particular has a resilience property worth pinning: each provider's
// status call carries its own catch, so one being down must not blank the other.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

import Integrations from './Integrations';

function status(path: string) {
  return String(path).includes('quickbooks') ? 'quickbooks' : 'shopify';
}

/** Answers both status calls, then hands later calls to `then`. */
function respondWith(qb: unknown, shopify: unknown, then?: (path: string) => unknown) {
  apiClient.mockImplementation(async (path: string) => {
    if (path.endsWith('/status')) {
      return { data: status(path) === 'quickbooks' ? qb : shopify };
    }
    if (then) return then(path);
    return { data: {} };
  });
}

/** Each provider card is its own <section>, which is what scopes the queries. */
function section(name: RegExp) {
  return screen.getByRole('heading', { name }).closest('section')!;
}

beforeEach(() => {
  apiClient.mockReset();
  // jsdom's window.location is not writable, and stubGlobal('location') does
  // not reach window.location, which is what the component assigns to.
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
    configurable: true,
  });
});

describe('Integrations loading', () => {
  it('shows both providers as disconnected when neither is set up', async () => {
    respondWith({ connected: false }, { connected: false });

    render(<Integrations />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2));
  });

  // Each status call has its own catch returning { connected: false }. Without
  // it, one provider being unreachable would reject the Promise.all and blank
  // the whole page, including the provider that is working.
  it('still renders one provider when the other status call fails', async () => {
    apiClient.mockImplementation(async (path: string) => {
      if (String(path).includes('quickbooks')) throw new Error('QuickBooks unavailable');
      return { data: { connected: true, syncStatus: 'idle' } };
    });

    render(<Integrations />);

    await waitFor(() => expect(screen.getByRole('heading', { name: /Shopify/ })).toBeInTheDocument());
    // Shopify is connected, so it offers Sync and Disconnect; QuickBooks fell
    // back to disconnected and offers Connect.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('offers sync and disconnect for a connected provider', async () => {
    respondWith({ connected: true, syncStatus: 'idle' }, { connected: false });

    render(<Integrations />);

    await waitFor(() =>
      expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Sync now' })).toBeInTheDocument(),
    );
    expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  // A sync already running upstream must not be re-triggerable from the UI.
  it('disables sync while the provider reports it is already syncing', async () => {
    respondWith({ connected: true, syncStatus: 'syncing' }, { connected: false });

    render(<Integrations />);

    await waitFor(() =>
      expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Sync now' })).toBeDisabled(),
    );
  });
});

describe('Integrations actions', () => {
  it('sends the user to the authorize URL the API returns', async () => {
    respondWith({ connected: false }, { connected: false }, () => ({
      data: { authUrl: 'https://appcenter.intuit.com/connect/oauth2?x=1' },
    }));

    const user = userEvent.setup();
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2));
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(window.location.href).toBe('https://appcenter.intuit.com/connect/oauth2?x=1'),
    );
  });

  // The shop domain is user input and is trimmed before it goes upstream, since
  // a stray space would otherwise be signed into the authorize URL.
  it('trims the shop domain before connecting', async () => {
    respondWith({ connected: false }, { connected: false }, () => ({
      data: { authUrl: 'https://store.myshopify.com/admin/oauth' },
    }));

    const user = userEvent.setup();
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2));
    await user.type(screen.getByPlaceholderText('your-store.myshopify.com'), '  my-store.myshopify.com  ');
    await user.click(within(section(/Shopify/)).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      const call = apiClient.mock.calls.find(([p]) => String(p).includes('shopify/connect'));
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body)).toEqual({ shop: 'my-store.myshopify.com' });
    });
  });

  // Disconnect flips local state rather than refetching, so the card has to
  // return to its connect affordance without another round trip.
  it('shows the provider as disconnected immediately after disconnecting', async () => {
    respondWith({ connected: true, syncStatus: 'idle' }, { connected: false });

    const user = userEvent.setup();
    render(<Integrations />);
    await waitFor(() =>
      expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument(),
    );
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() =>
      expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' })).toBeInTheDocument(),
    );
  });

  // Sync reloads rather than assuming success, because the row it just queued
  // carries the timestamp and any error the next render shows.
  it('reloads both statuses after a sync', async () => {
    respondWith({ connected: true, syncStatus: 'idle' }, { connected: false });

    const user = userEvent.setup();
    render(<Integrations />);
    await waitFor(() =>
      expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Sync now' })).toBeInTheDocument(),
    );
    const before = apiClient.mock.calls.filter(([p]) => String(p).endsWith('/status')).length;
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      const after = apiClient.mock.calls.filter(([p]) => String(p).endsWith('/status')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('surfaces a failed action and lets it be dismissed', async () => {
    respondWith({ connected: false }, { connected: false }, () => {
      throw new Error('Intuit is unavailable');
    });

    const user = userEvent.setup();
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2));
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Intuit is unavailable')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Dismiss error'));
    expect(screen.queryByText('Intuit is unavailable')).not.toBeInTheDocument();
  });
});
