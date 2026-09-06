import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// No test file existed for any of the four auth forms. Three of them carry the
// same open-redirect guard and none of it was exercised.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import PasswordLoginForm from './PasswordLoginForm';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function ok() {
  return new Response(JSON.stringify({ data: { user: { id: 1 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function signIn(redirectPath = '/dashboard') {
  const user = userEvent.setup();
  render(<PasswordLoginForm redirectPath={redirectPath} />);
  await user.type(screen.getByPlaceholderText('Email'), 'a@b.test');
  await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
  return user;
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
});

describe('PasswordLoginForm submission', () => {
  it('posts the credentials with cookies attached', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await signIn();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/signin');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.test', password: 'hunter2' });
  });

  it('surfaces the message the API gave, not a generic one', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Account locked' } }), { status: 401 }),
    );

    await signIn();

    expect(await screen.findByText('Account locked')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the API sends none', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }));

    await signIn();

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
  });

  // Without this the button stays disabled after a failure and the user cannot
  // try again without reloading.
  it('re-enables the button after a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }));

    await signIn();

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled());
  });
});

// The guard is `startsWith('/') && !startsWith('//')`. Both halves matter:
// without the first an absolute URL passes, and without the second `//evil.com`
// is protocol-relative and reads as an absolute URL to the browser.
describe('PasswordLoginForm redirect guard', () => {
  it.each(['/dashboard', '/upload', '/settings/alerts', '/dashboard?dataset=3'])(
    'honours the relative path %s',
    async (path) => {
      fetchMock.mockResolvedValueOnce(ok());

      await signIn(path);

      await waitFor(() => expect(push).toHaveBeenCalledWith(path));
    },
  );

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['an absolute http URL', 'http://evil.example/steal'],
    ['an absolute https URL', 'https://evil.example'],
    ['a bare host', 'evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['an empty string', ''],
  ])('refuses %s and sends the user to the dashboard', async (_label, path) => {
    fetchMock.mockResolvedValueOnce(ok());

    await signIn(path);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  });
});
