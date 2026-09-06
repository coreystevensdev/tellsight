import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ForgotPasswordForm from './ForgotPasswordForm';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

async function request(email = 'marcus@b.test') {
  const user = userEvent.setup();
  render(<ForgotPasswordForm />);
  await user.type(screen.getByPlaceholderText('Email'), email);
  await user.click(screen.getByRole('button', { name: /send|reset/i }));
}

beforeEach(() => fetchMock.mockReset());

describe('ForgotPasswordForm', () => {
  it('posts the address to the reset endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }));

    await request();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/forgot-password');
    expect(JSON.parse(init.body)).toEqual({ email: 'marcus@b.test' });
  });

  // The confirmation is deliberately conditional: saying "we sent a link"
  // outright would confirm the address exists. The wording is the anti
  // enumeration guarantee, so it is asserted rather than just the state change.
  it('confirms without revealing whether the account exists', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }));

    await request();

    expect(await screen.findByText(/If an account exists/)).toBeInTheDocument();
    expect(screen.getByText('marcus@b.test')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Email')).not.toBeInTheDocument();
  });

  it('shows the API message on failure and keeps the form open', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429 }),
    );

    await request();

    expect(await screen.findByText('Too many requests')).toBeInTheDocument();
    expect(screen.queryByText(/If an account exists/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
  });

  // The finally block. Without it a failed attempt leaves the button disabled
  // and the user cannot try a different address.
  it('re-enables the button after a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 500 }));

    await request();

    await waitFor(() => expect(screen.getByRole('button', { name: /send|reset/i })).toBeEnabled());
  });
});
