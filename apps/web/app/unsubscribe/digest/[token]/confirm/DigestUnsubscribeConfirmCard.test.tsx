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
});
