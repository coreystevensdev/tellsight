import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DigestUnsubscribeConfirmCard } from './DigestUnsubscribeConfirmCard';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DigestUnsubscribeConfirmCard', () => {
  it('does not call the unsubscribe endpoint on render, only on explicit confirm', () => {
    render(<DigestUnsubscribeConfirmCard token="tok-1" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the token-scoped unsubscribe route when the button is clicked', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { unsubscribed: true } }) });
    render(<DigestUnsubscribeConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unsubscribe/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/digest/unsubscribe/tok-1', { method: 'POST' });
    });
    expect(await screen.findByText(/won't receive any more weekly digest/i)).toBeInTheDocument();
  });

  it('shows the server error message when the token is invalid', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This unsubscribe link has expired or is invalid.' } }),
    });
    render(<DigestUnsubscribeConfirmCard token="tok-bad" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unsubscribe/i }));

    expect(await screen.findByText(/expired or is invalid/i)).toBeInTheDocument();
  });

  it('shows the network error message when the fetch itself rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<DigestUnsubscribeConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unsubscribe/i }));

    expect(await screen.findByText(/couldn't reach our server/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only fires one request when the button is clicked twice before the first request settles', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<DigestUnsubscribeConfirmCard token="tok-1" />);

    const button = screen.getByRole('button', { name: /confirm unsubscribe/i });
    fireEvent.click(button);
    fireEvent.click(button);

    resolveFetch({ ok: true, json: async () => ({ data: { unsubscribed: true } }) });
    await screen.findByText(/won't receive any more weekly digest/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns to the confirm button after "Try again" is clicked on an error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'This unsubscribe link has expired or is invalid.' } }),
    });
    render(<DigestUnsubscribeConfirmCard token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: /confirm unsubscribe/i }));
    await screen.findByText(/expired or is invalid/i);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('button', { name: /confirm unsubscribe/i })).toBeInTheDocument();
    expect(screen.queryByText(/expired or is invalid/i)).not.toBeInTheDocument();
  });
});
