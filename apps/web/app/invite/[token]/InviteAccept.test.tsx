import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// No test file, and no reference from any other test.

import InviteAccept from './InviteAccept';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
    configurable: true,
  });
});

describe('InviteAccept validation', () => {
  it('names the org once the invite validates', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { orgName: 'Acme Coffee' } }));

    render(<InviteAccept token="tok-1" />);

    expect(await screen.findByRole('heading', { name: /Join Acme Coffee/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/invites/tok-1');
  });

  // An expired or revoked invite has to say so rather than offering a join
  // button that will fail after the OAuth round trip.
  it('shows the API reason and no join button for an invalid invite', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'This invite has expired' } }, 410));

    render(<InviteAccept token="tok-1" />);

    expect(await screen.findByText('This invite has expired')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to a generic reason when the API sends none', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));

    render(<InviteAccept token="tok-1" />);

    expect(await screen.findByText(/no longer valid/)).toBeInTheDocument();
  });

  it('reports a network failure rather than hanging on the spinner', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    render(<InviteAccept token="tok-1" />);

    expect(await screen.findByText('Failed to validate invite link')).toBeInTheDocument();
    expect(screen.queryByText(/Checking invite/)).not.toBeInTheDocument();
  });
});

describe('InviteAccept joining', () => {
  async function validated() {
    fetchMock.mockResolvedValueOnce(json({ data: { orgName: 'Acme Coffee' } }));
    const user = userEvent.setup();
    render(<InviteAccept token="tok-1" />);
    await screen.findByRole('heading', { name: /Join Acme Coffee/ });
    return user;
  }

  // The token has to survive the OAuth round trip, and sessionStorage is the
  // only thing carrying it: CallbackHandler reads this exact key on the way
  // back. Without it the user signs in successfully and lands in their own new
  // org rather than the one that invited them.
  it('stashes the invite token before starting sign-in', async () => {
    const user = await validated();
    fetchMock.mockResolvedValueOnce(json({ data: { url: 'https://accounts.google.com/o/oauth2/auth?x=1' } }));

    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?x=1'));
    expect(sessionStorage.getItem('pending_invite_token')).toBe('tok-1');
  });

  it('surfaces a failure to start sign-in and re-enables the button', async () => {
    const user = await validated();
    fetchMock.mockResolvedValueOnce(json({}, 500));

    await user.click(screen.getByRole('button'));

    expect(await screen.findByText('Failed to start sign-in')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });
});
