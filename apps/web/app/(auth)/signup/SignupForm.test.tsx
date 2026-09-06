import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import SignupForm from './SignupForm';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function ok() {
  return new Response(JSON.stringify({ data: { user: { id: 1 } } }), { status: 200 });
}

async function signUp(props: { redirectPath?: string; inviteToken?: string } = {}) {
  const user = userEvent.setup();
  render(<SignupForm redirectPath={props.redirectPath ?? '/dashboard'} inviteToken={props.inviteToken} />);
  await user.type(screen.getByPlaceholderText('Name'), 'Marcus');
  await user.type(screen.getByPlaceholderText('Email'), 'marcus@b.test');
  await user.type(screen.getByPlaceholderText(/^Password/), 'longenough1');
  await user.click(screen.getByRole('button', { name: /create account|sign up/i }));
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
});

describe('SignupForm', () => {
  it('posts every field the account needs', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await signUp();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      name: 'Marcus',
      email: 'marcus@b.test',
      password: 'longenough1',
      inviteToken: undefined,
    });
  });

  // Signing up through an invite has to carry the token, or the new account
  // lands in its own org instead of the one that invited them.
  it('carries an invite token when one is present', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await signUp({ inviteToken: 'inv-123' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).inviteToken).toBe('inv-123');
  });

  it('surfaces the API message on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Email already registered' } }), { status: 409 }),
    );

    await signUp();

    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['/dashboard', '/settings/alerts'])('honours the relative path %s', async (path) => {
    fetchMock.mockResolvedValueOnce(ok());

    await signUp({ redirectPath: path });

    await waitFor(() => expect(push).toHaveBeenCalledWith(path));
  });

  it.each(['//evil.example', 'https://evil.example', 'evil.example'])(
    'refuses %s as a redirect target',
    async (path) => {
      fetchMock.mockResolvedValueOnce(ok());

      await signUp({ redirectPath: path });

      await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    },
  );
});
