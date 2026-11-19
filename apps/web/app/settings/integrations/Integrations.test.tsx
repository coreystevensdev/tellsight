import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 325 lines with no test file and no reference from any other test. The load
// path in particular has a resilience property worth pinning: each provider's
// status call carries its own catch, so one being down must not blank the other.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

// The real SDK injects a script tag from Plaid's CDN, which jsdom would try to
// fetch. `open` is captured so the tests can assert Link was opened without
// standing up an iframe.
const plaidOpen = vi.fn();
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (opts: { token: string | null }) => ({
    open: plaidOpen,
    ready: Boolean(opts.token),
  }),
}));

import Integrations from './Integrations';

// Explicit rather than falling through to one provider. It used to return
// 'shopify' for anything unmatched, so adding Plaid silently served it
// Shopify's payload and the only symptom was a card showing the wrong thing.
function status(path: string) {
  const p = String(path);
  for (const name of ['quickbooks', 'square', 'shopify', 'plaid', 'xero'] as const) {
    if (p.includes(name)) return name;
  }
  throw new Error(`status() does not know this provider: ${p}`);
}

/** Answers every status call, then hands later calls to `then`. */
function respondWith(
  qb: unknown,
  shopify: unknown,
  then?: (path: string) => unknown,
  square: unknown = { connected: false },
  plaid: unknown = { connected: false },
  xero: unknown = { connected: false },
) {
  const byProvider = { quickbooks: qb, shopify, square, plaid, xero };
  apiClient.mockImplementation(async (path: string) => {
    if (path.endsWith('/status')) return { data: byProvider[status(path)] };
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
  plaidOpen.mockReset();
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

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
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
    // Scoped per section rather than globally: the others are connected and
    // offer Sync, QuickBooks fell back to disconnected and offers Connect, and
    // the point is that its failure did not take them with it.
    expect(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(within(section(/Shopify/)).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(within(section(/^Square$/)).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
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

    const user = userEvent.setup({ delay: null });
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(window.location.href).toBe('https://appcenter.intuit.com/connect/oauth2?x=1'),
    );
  });

  // A connector nobody can click is not shipped. This is the whole chain for
  // Xero in one assertion: the card renders, its own button is the one clicked,
  // and the request goes to Xero's endpoint rather than the QuickBooks one
  // directly above it in the list.
  it('sends the Xero card to the Xero connect endpoint', async () => {
    respondWith({ connected: false }, { connected: false }, () => ({
      data: { authUrl: 'https://login.xero.com/identity/connect/authorize?x=1' },
    }));

    const user = userEvent.setup({ delay: null });
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
    await user.click(within(section(/^Xero$/)).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(apiClient.mock.calls.some(([p]) => String(p) === '/integrations/xero/connect')).toBe(
        true,
      );
      expect(window.location.href).toBe('https://login.xero.com/identity/connect/authorize?x=1');
    });
  });

  it('syncs and disconnects Xero through its own routes', async () => {
    respondWith({ connected: false }, { connected: false }, () => ({ data: {} }), undefined, undefined, {
      connected: true,
      companyName: 'Maple Florist',
    });

    const user = userEvent.setup({ delay: null });
    render(<Integrations />);
    await waitFor(() => expect(section(/^Xero$/)).toBeTruthy());

    await user.click(within(section(/^Xero$/)).getByRole('button', { name: /sync/i }));
    await waitFor(() =>
      expect(apiClient.mock.calls.some(([p]) => String(p) === '/integrations/xero/sync')).toBe(true),
    );

    await user.click(within(section(/^Xero$/)).getByRole('button', { name: /disconnect/i }));
    await waitFor(() => {
      const call = apiClient.mock.calls.find(([p]) => String(p) === '/integrations/xero');
      expect(call?.[1]?.method).toBe('DELETE');
    });
  });

  // The shop domain is user input and is trimmed before it goes upstream, since
  // a stray space would otherwise be signed into the authorize URL.
  it('trims the shop domain before connecting', async () => {
    respondWith({ connected: false }, { connected: false }, () => ({
      data: { authUrl: 'https://store.myshopify.com/admin/oauth' },
    }));

    const user = userEvent.setup({ delay: null });
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
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
  // A provider with no credentials answers 501 INTEGRATION_NOT_CONFIGURED. Before
  // this, that collapsed into connected:false and the card drew a Connect button
  // that could only fail, so a visitor was invited to start an OAuth flow this
  // deployment cannot finish. Switched off and broken are different things.
  it('offers no Connect button for a provider this deployment has not configured', async () => {
    apiClient.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/status')) {
        throw Object.assign(new Error('API error: 501'), { status: 501, code: 'INTEGRATION_NOT_CONFIGURED' });
      }
      return { data: {} };
    });

    render(<Integrations />);

    await waitFor(() =>
      expect(screen.getAllByText(/not available in this deployment/i)).toHaveLength(5),
    );
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  // Only a 501 means unconfigured. Any other failure is a provider that exists
  // and is briefly unreachable, and hiding Connect then strands someone who
  // could otherwise just retry.
  it('still offers Connect when the status call fails for any other reason', async () => {
    apiClient.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/status')) {
        throw Object.assign(new Error('API error: 503'), { status: 503, code: 'UPSTREAM_UNAVAILABLE' });
      }
      return { data: {} };
    });

    render(<Integrations />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
    expect(screen.queryByText(/not available in this deployment/i)).toBeNull();
  });

  it('shows the provider as disconnected immediately after disconnecting', async () => {
    respondWith({ connected: true, syncStatus: 'idle' }, { connected: false });

    const user = userEvent.setup({ delay: null });
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

    const user = userEvent.setup({ delay: null });
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

    const user = userEvent.setup({ delay: null });
    render(<Integrations />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(5));
    await user.click(within(section(/QuickBooks/)).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Intuit is unavailable')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Dismiss error'));
    expect(screen.queryByText('Intuit is unavailable')).not.toBeInTheDocument();
  });
});

// Shopify is the only card whose Connect needs input, so it is the only one
// that can present an enabled-looking button that does nothing. It was already
// disabled on an empty domain, and said nothing about why, which is how a real
// reconnect stalled: the button looked live, the click did nothing, and the
// card went on reading "Connect".
describe('Shopify needs a store domain before Connect does anything', () => {
  function shopifyCard() {
    return section(/shopify/i);
  }

  async function renderDisconnected() {
    respondWith({ connected: false }, { connected: false });
    render(<Integrations />);
    await waitFor(() => expect(shopifyCard()).toBeTruthy());
  }

  it('says what is missing rather than silently disabling', async () => {
    await renderDisconnected();

    expect(within(shopifyCard()).getByText(/enter your store domain/i)).toBeInTheDocument();
    expect(within(shopifyCard()).getByRole('button', { name: /^connect$/i })).toBeDisabled();
  });

  it('rejects a domain the server would reject, before sending it', async () => {
    const user = userEvent.setup({ delay: null });
    await renderDisconnected();

    await user.type(within(shopifyCard()).getByLabelText(/store domain/i), 'https://my-store.com');

    expect(within(shopifyCard()).getByText(/not a store domain/i)).toBeInTheDocument();
    expect(within(shopifyCard()).getByRole('button', { name: /^connect$/i })).toBeDisabled();
    // The point of validating here is that nothing is sent at all.
    expect(apiClient.mock.calls.filter((c) => String(c[0]).includes('shopify/connect'))).toHaveLength(0);
  });

  it('enables Connect once the domain matches what Shopify accepts', async () => {
    const user = userEvent.setup({ delay: null });
    await renderDisconnected();

    await user.type(within(shopifyCard()).getByLabelText(/store domain/i), 'my-store.myshopify.com');

    expect(within(shopifyCard()).getByRole('button', { name: /^connect$/i })).toBeEnabled();
  });

  it('marks the field invalid for assistive tech, not just visually', async () => {
    const user = userEvent.setup({ delay: null });
    await renderDisconnected();
    const field = within(shopifyCard()).getByLabelText(/store domain/i);

    await user.type(field, 'nope');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });
});

// All three cards used to render the same lucide chain-link icon, and
// QuickBooks and Shopify also shared an emerald tile, so two of the three were
// identical but for their heading. Tile colour alone is not identification.
describe('each connector card shows its own mark', () => {
  it('gives every card its own mark', async () => {
    respondWith({ connected: true, companyName: '9341457586501237' }, { connected: false }, undefined, {
      connected: true,
      merchantId: 'MLWEC01GRVSA3',
    });
    render(<Integrations />);
    await waitFor(() => expect(section(/quickbooks/i)).toBeTruthy());

    const marks = [...document.querySelectorAll('[data-mark]')].map((n) => n.getAttribute('data-mark'));

    expect(marks).toEqual(['quickbooks', 'ledger', 'shopify', 'square', 'bank']);
    // 'bank' rather than a Plaid mark on purpose: the card is about the owner's
    // bank, and there is no verified Plaid path to draw from. 'ledger' on the
    // Xero card for the same reason, and it costs more there because that card
    // really is about the brand: a mark drawn from memory would be a wrong
    // logo rather than a missing one.
    // Distinctness against the list's own length rather than a literal, which
    // is the assertion that actually matters and does not need editing when a
    // fifth connector lands.
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('keeps the provider mark when disconnected, rather than a generic slot', async () => {
    respondWith({ connected: false }, { connected: false }, undefined, { connected: false });
    render(<Integrations />);
    await waitFor(() => expect(section(/shopify/i)).toBeTruthy());

    expect(within(section(/shopify/i)).getByRole('heading', { name: /shopify/i })).toBeTruthy();
    expect(section(/shopify/i).querySelector('[data-mark="shopify"]')).toBeTruthy();
  });
});
