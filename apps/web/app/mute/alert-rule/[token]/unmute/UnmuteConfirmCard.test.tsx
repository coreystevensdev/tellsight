import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UnmuteConfirmCard } from './UnmuteConfirmCard';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UnmuteConfirmCard', () => {
  it('does not call the unmute endpoint on render, only on explicit confirm', () => {
    render(<UnmuteConfirmCard token="tok-1" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the token-scoped unmute route when the button is clicked', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { muted: false } }) });
    render(<UnmuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mute/alert-rule/tok-1/unmute', { method: 'POST' });
    });
    expect(await screen.findByText(/notified again/i)).toBeInTheDocument();
  });

  it('shows the server error message when the token is invalid', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This unmute link has expired or is invalid.' } }),
    });
    render(<UnmuteConfirmCard token="tok-bad" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));

    expect(await screen.findByText(/expired or is invalid/i)).toBeInTheDocument();
  });
});
