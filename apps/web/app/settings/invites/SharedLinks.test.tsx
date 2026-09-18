import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...a: unknown[]) => apiClient(...a) }));

import SharedLinks from './SharedLinks';

const rows = [
  { id: 5, datasetId: 2, expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(), viewCount: 3, isMine: true },
  { id: 6, datasetId: 2, expiresAt: null, viewCount: 0, isMine: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.mockResolvedValue({ data: rows });
});

describe('SharedLinks', () => {
  it('lists the links with what they cost you, not how to use them', async () => {
    render(<SharedLinks />);

    expect(await screen.findAllByText(/Link #/)).toHaveLength(2);
    expect(screen.getByText(/3 views/)).toBeInTheDocument();
    expect(screen.getByText(/shared by someone else/)).toBeInTheDocument();
  });

  it('revokes and reloads', async () => {
    const user = userEvent.setup();
    render(<SharedLinks />);
    await screen.findAllByText(/Link #/);

    await user.click(screen.getByRole('button', { name: 'Revoke shared link 5' }));

    await waitFor(() => expect(apiClient).toHaveBeenCalledWith('/shares/5', { method: 'DELETE' }));
  });

  it('surfaces a refusal rather than pretending it worked', async () => {
    const user = userEvent.setup();
    render(<SharedLinks />);
    await screen.findAllByText(/Link #/);
    apiClient.mockRejectedValueOnce(new Error('Only the owner or whoever made it can revoke a share'));

    await user.click(screen.getByRole('button', { name: 'Revoke shared link 6' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/only the owner/i);
  });

  // An org with no links should not get an empty box with a heading over it.
  it('renders nothing when there are none', async () => {
    apiClient.mockResolvedValue({ data: [] });
    const { container } = render(<SharedLinks />);

    await waitFor(() => expect(apiClient).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
