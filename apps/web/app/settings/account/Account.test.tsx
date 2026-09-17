import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/common/BackLink', () => ({ BackLink: () => null }));

const assign = vi.fn();
Object.defineProperty(window, 'location', { value: { assign }, writable: true });

import Account from './Account';

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = (body: unknown) => ({ ok: false, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

async function arm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/type .* to confirm/i), 'delete my account');
}

describe('Account deletion', () => {
  it('keeps the button disabled until the phrase is typed', async () => {
    const user = userEvent.setup();
    render(<Account />);
    const button = screen.getByRole('button', { name: /delete account/i });

    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/type .* to confirm/i), 'delete');
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/type .* to confirm/i), ' my account');
    expect(button).toBeEnabled();
  });

  it('never calls the endpoint while the phrase is wrong', async () => {
    const user = userEvent.setup();
    render(<Account />);

    await user.type(screen.getByLabelText(/type .* to confirm/i), 'delete my acount');
    await user.click(screen.getByRole('button', { name: /delete account/i }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('leaves the signed-in world once the account is gone', async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValue(ok({ data: { deletedOrgIds: [1], leftOrgIds: [] } }) as never);
    render(<Account />);

    await arm(user);
    await user.click(screen.getByRole('button', { name: /delete account/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(global.fetch).toHaveBeenCalledWith('/api/account', { method: 'DELETE' });
  });

  // The one refusal the server has, and the only one a person can act on.
  it('names the orgs that need a new owner first', async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValue(fail({
      error: { message: 'Transfer ownership', details: { organizations: [{ orgId: 3, orgName: 'Sunrise Cafe' }] } },
    }) as never);
    render(<Account />);

    await arm(user);
    await user.click(screen.getByRole('button', { name: /delete account/i }));

    expect(await screen.findByText('Sunrise Cafe')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('says the account survived when the request never lands', async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    render(<Account />);

    await arm(user);
    await user.click(screen.getByRole('button', { name: /delete account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/has not been deleted/i);
    expect(assign).not.toHaveBeenCalled();
  });
});
