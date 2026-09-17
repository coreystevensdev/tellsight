import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...a: unknown[]) => apiClient(...a) }));

import Members from './Members';

const roster = [
  { isSelf: true, userId: 1, role: 'owner', name: 'Ada', email: 'ada@x.test' },
  { isSelf: false, userId: 2, role: 'member', name: 'Bo', email: 'bo@x.test' },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.mockResolvedValue({ data: roster });
});

describe('Members', () => {
  it('lists everyone and marks the caller', async () => {
    render(<Members />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
    expect(screen.getByText('you')).toBeInTheDocument();
  });

  // The server refuses it too, but an owner should not be offered a button that
  // strands their own org.
  it('offers no way to remove yourself', async () => {
    render(<Members />);
    await screen.findByText('Ada');

    const buttons = screen.getAllByRole('button', { name: /remove .* from this organization/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/remove bo/i);
  });

  it('asks before removing, and does nothing until confirmed', async () => {
    const user = userEvent.setup();
    render(<Members />);
    await screen.findByText('Bo');

    await user.click(screen.getByRole('button', { name: /remove bo from this organization/i }));

    expect(await screen.findByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
    expect(apiClient).toHaveBeenCalledTimes(1); // the list only
  });

  it('deletes and reloads once confirmed', async () => {
    const user = userEvent.setup();
    render(<Members />);
    await screen.findByText('Bo');

    await user.click(screen.getByRole('button', { name: /remove bo from this organization/i }));
    await user.click(await screen.findByRole('button', { name: 'Remove Bo' }));

    await waitFor(() =>
      expect(apiClient).toHaveBeenCalledWith('/org/members/2', { method: 'DELETE' }),
    );
  });

  it('backs out without calling anything', async () => {
    const user = userEvent.setup();
    render(<Members />);
    await screen.findByText('Bo');

    await user.click(screen.getByRole('button', { name: /remove bo from this organization/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Remove Bo' })).not.toBeInTheDocument();
    expect(apiClient).toHaveBeenCalledTimes(1);
  });

  it('says so when the removal fails', async () => {
    const user = userEvent.setup();
    render(<Members />);
    await screen.findByText('Bo');
    apiClient.mockRejectedValueOnce(new Error('Owner access required'));

    await user.click(screen.getByRole('button', { name: /remove bo from this organization/i }));
    await user.click(await screen.findByRole('button', { name: 'Remove Bo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Owner access required');
  });
});
