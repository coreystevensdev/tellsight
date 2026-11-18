import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The Plaid flow is the one connector that does not navigate away, so none of
// the redirect assertions in Integrations.test.tsx cover it. What matters here
// is the order: a link token is fetched, Link is opened with it, and only the
// public token Link returns is posted back. The access token never touches the
// browser, which is the whole reason the exchange is a server call.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

const plaidOpen = vi.fn();
let captured: {
  token: string | null;
  onSuccess: (token: string | null, meta: unknown) => void;
  onExit: (err: unknown) => void;
};

// Stands in for the SDK, which would otherwise inject a script from Plaid's CDN.
// `ready` follows the token exactly as the real hook does, because the component
// opens Link on that transition.
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (opts: typeof captured) => {
    captured = opts;
    return { open: plaidOpen, ready: Boolean(opts.token) };
  },
}));

const { usePlaidConnect } = await import('./usePlaidConnect');

const onConnected = vi.fn();
const onError = vi.fn();

function Harness() {
  const { connect, connecting } = usePlaidConnect({ onConnected, onError });
  return (
    <button type="button" onClick={connect} data-busy={connecting}>
      {connecting ? 'Connecting' : 'Connect'}
    </button>
  );
}

beforeEach(() => {
  apiClient.mockReset();
  plaidOpen.mockReset();
  onConnected.mockReset();
  onError.mockReset();
  apiClient.mockResolvedValue({ data: { linkToken: 'link-sandbox-abc' } });
});

describe('usePlaidConnect', () => {
  it('fetches a link token and opens Link with it', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));

    expect(apiClient).toHaveBeenCalledWith('/integrations/plaid/link-token', { method: 'POST' });
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());
    expect(captured.token).toBe('link-sandbox-abc');
  });

  it('does not open Link before it has a token', () => {
    render(<Harness />);

    expect(captured.token).toBeNull();
    expect(plaidOpen).not.toHaveBeenCalled();
  });

  it('posts the public token and the institution name to be exchanged', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onSuccess('public-sandbox-xyz', { institution: { name: 'Chase' } });

    await waitFor(() =>
      expect(apiClient).toHaveBeenCalledWith('/integrations/plaid/exchange', {
        method: 'POST',
        body: JSON.stringify({ publicToken: 'public-sandbox-xyz', institutionName: 'Chase' }),
      }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it('sends an empty institution name rather than omitting it', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onSuccess('public-sandbox-xyz', {});

    await waitFor(() => {
      const body = apiClient.mock.calls.find((c) => String(c[0]).endsWith('/exchange'))?.[1]?.body;
      expect(JSON.parse(String(body))).toEqual({
        publicToken: 'public-sandbox-xyz',
        institutionName: '',
      });
    });
  });

  // The SDK types the public token as nullable. Posting null would fail
  // validation at the API with a message about a missing field, which tells the
  // owner nothing about what went wrong.
  it('reports a problem rather than posting a null public token', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onSuccess(null, { institution: { name: 'Chase' } });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(apiClient.mock.calls.some((c) => String(c[0]).endsWith('/exchange'))).toBe(false);
  });

  // Closing Link is the common case and is not a failure, so it must not raise
  // an error banner on a screen the owner deliberately dismissed.
  it('stays quiet when the owner just closes Link', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onExit(null);

    expect(onError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('data-busy', 'false'));
  });

  it('reports a real Link failure', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onExit({ error_code: 'INVALID_LINK_TOKEN' });

    expect(onError).toHaveBeenCalled();
  });

  // A link token is single-use: Plaid rejects one that has already completed, so
  // keeping it would make the next attempt fail instead of opening Link again.
  it('drops the token after a connection so a second attempt fetches a new one', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    captured.onSuccess('public-sandbox-xyz', { institution: { name: 'Chase' } });

    await waitFor(() => expect(captured.token).toBeNull());
  });

  it('surfaces a failure to mint a link token and stops being busy', async () => {
    apiClient.mockRejectedValueOnce(new Error('Bank connections are not configured'));
    render(<Harness />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Bank connections are not configured'),
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-busy', 'false');
    expect(plaidOpen).not.toHaveBeenCalled();
  });

  it('surfaces a failed exchange', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());

    apiClient.mockRejectedValueOnce(new Error('A bank account is already connected'));
    captured.onSuccess('public-sandbox-xyz', { institution: { name: 'Chase' } });

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('A bank account is already connected'),
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('reports busy while the token is being fetched', async () => {
    let release: (v: unknown) => void = () => {};
    apiClient.mockReturnValueOnce(new Promise((r) => { release = r; }));
    render(<Harness />);

    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveAttribute('data-busy', 'true');

    release({ data: { linkToken: 'link-sandbox-abc' } });
    await waitFor(() => expect(plaidOpen).toHaveBeenCalled());
  });
});
