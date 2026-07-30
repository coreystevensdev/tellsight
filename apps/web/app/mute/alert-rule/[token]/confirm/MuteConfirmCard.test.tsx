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

  it('shows the network error message when the fetch itself rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<MuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm mute/i }));

    expect(await screen.findByText(/couldn't reach our server/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only fires one request when the button is clicked twice before the first request settles', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<MuteConfirmCard token="tok-1" />);

    const button = screen.getByRole('button', { name: /confirm mute/i });
    fireEvent.click(button);
    fireEvent.click(button);

    resolveFetch({
      ok: true,
      json: async () => ({
        data: { muteUntil: '2026-08-19T00:00:00.000Z', ruleKindLabel: 'runway alerts', orgName: 'Acme Co' },
      }),
    });
    await screen.findByText(/runway alerts for Acme Co/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns to the confirm button after "Try again" is clicked on an error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This mute link has expired or is invalid.' } }),
    });
    render(<MuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm mute/i }));
    await screen.findByText(/expired or is invalid/i);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('button', { name: /confirm mute/i })).toBeInTheDocument();
    expect(screen.queryByText(/expired or is invalid/i)).not.toBeInTheDocument();
  });
});
