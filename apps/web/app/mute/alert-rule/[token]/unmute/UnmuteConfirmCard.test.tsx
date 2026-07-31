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
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/mute/alert-rule/tok-1/unmute',
        expect.objectContaining({ method: 'POST' }),
      );
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

  it('shows the network error message when the fetch itself rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<UnmuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));

    expect(await screen.findByText(/couldn't reach our server/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only fires one request when the button is clicked twice before the first request settles', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<UnmuteConfirmCard token="tok-1" />);

    const button = screen.getByRole('button', { name: /confirm unmute/i });
    fireEvent.click(button);
    fireEvent.click(button);

    resolveFetch({ ok: true, json: async () => ({ data: { muted: false } }) });
    await screen.findByText(/notified again/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns to the confirm button after "Try again" is clicked on an error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This unmute link has expired or is invalid.' } }),
    });
    render(<UnmuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));
    await screen.findByText(/expired or is invalid/i);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('button', { name: /confirm unmute/i })).toBeInTheDocument();
    expect(screen.queryByText(/expired or is invalid/i)).not.toBeInTheDocument();
  });

  it('moves focus to the confirm button after "Try again" is clicked', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This unmute link has expired or is invalid.' } }),
    });
    render(<UnmuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));
    await screen.findByText(/expired or is invalid/i);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('button', { name: /confirm unmute/i })).toHaveFocus();
  });

  it('does not autofocus the confirm button on initial mount', () => {
    render(<UnmuteConfirmCard token="tok-1" />);

    expect(screen.getByRole('button', { name: /confirm unmute/i })).not.toHaveFocus();
  });

  it('aborts the in-flight request when the component unmounts', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const { unmount } = render(<UnmuteConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unmute/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const signal = (fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
    resolveFetch({ ok: true, json: async () => ({ data: { muted: false } }) });
  });
});
