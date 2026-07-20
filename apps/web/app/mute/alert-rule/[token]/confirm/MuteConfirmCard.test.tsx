import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MuteConfirmCard } from './MuteConfirmCard';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MuteConfirmCard', () => {
  it('does not call the mute endpoint on render, only on explicit confirm', () => {
    render(<MuteConfirmCard token="tok-1" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the token-scoped mute route when the button is clicked', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          muteUntil: '2026-08-19T00:00:00.000Z',
          ruleKindLabel: 'runway alerts',
          orgName: 'Acme Co',
        },
      }),
    });
    render(<MuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm mute/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mute/alert-rule/tok-1', { method: 'POST' });
    });
    expect(await screen.findByText(/runway alerts for Acme Co/i)).toBeInTheDocument();
  });

  it('shows the server error message when the token is invalid', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This mute link has expired or is invalid.' } }),
    });
    render(<MuteConfirmCard token="tok-bad" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm mute/i }));

    expect(await screen.findByText(/expired or is invalid/i)).toBeInTheDocument();
  });
});
