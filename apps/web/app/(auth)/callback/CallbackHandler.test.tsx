import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import CallbackHandler from './CallbackHandler';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function ok() {
  return new Response(JSON.stringify({ data: { user: { id: 1 } } }), { status: 200 });
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  sessionStorage.clear();
});

describe('CallbackHandler', () => {
  it('exchanges the code and state with cookies attached', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    render(<CallbackHandler code="c1" state="s1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/callback');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toMatchObject({ code: 'c1', state: 's1' });
  });

  it.each([
    ['no code', undefined, 's1'],
    ['no state', 'c1', undefined],
    ['neither', undefined, undefined],
  ])('refuses to exchange with %s', async (_label, code, state) => {
    render(<CallbackHandler code={code} state={state} />);

    expect(await screen.findByText(/Missing authentication parameters/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A pending invite has to survive the OAuth round trip, and has to be cleared
  // afterwards or the next sign-in on the same browser joins the wrong org.
  it('forwards a pending invite token and clears it', async () => {
    sessionStorage.setItem('pending_invite_token', 'inv-9');
    fetchMock.mockResolvedValueOnce(ok());

    render(<CallbackHandler code="c1" state="s1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).inviteToken).toBe('inv-9');
    expect(sessionStorage.getItem('pending_invite_token')).toBeNull();
  });

  it('surfaces the API message when the exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'State mismatch' } }), { status: 401 }),
    );

    render(<CallbackHandler code="c1" state="s1" />);

    expect(await screen.findByText('State mismatch')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

// This redirect target comes out of sessionStorage rather than a prop, so
// anything able to write that key chooses where a freshly-authenticated user
// lands. The guard is the only thing between that and an open redirect, and the
// comment above it says so.
describe('CallbackHandler redirect guard', () => {
  it.each(['/dashboard', '/upload', '/settings/alerts?tab=email'])(
    'honours the stored relative path %s',
    async (stored) => {
      sessionStorage.setItem('auth_redirect', stored);
      fetchMock.mockResolvedValueOnce(ok());

      render(<CallbackHandler code="c1" state="s1" />);

      await waitFor(() => expect(push).toHaveBeenCalledWith(stored));
    },
  );

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['an absolute URL', 'https://evil.example/callback'],
    ['a bare host', 'evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
  ])('refuses %s from sessionStorage', async (_label, stored) => {
    sessionStorage.setItem('auth_redirect', stored);
    fetchMock.mockResolvedValueOnce(ok());

    render(<CallbackHandler code="c1" state="s1" />);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  });

  it('defaults to the dashboard when nothing was stored', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    render(<CallbackHandler code="c1" state="s1" />);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  });

  // Left behind, it would hijack the next sign-in on the same browser.
  it('clears the stored target once it has been used', async () => {
    sessionStorage.setItem('auth_redirect', '/upload');
    fetchMock.mockResolvedValueOnce(ok());

    render(<CallbackHandler code="c1" state="s1" />);

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sessionStorage.getItem('auth_redirect')).toBeNull();
  });
});
