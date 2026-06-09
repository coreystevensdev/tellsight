import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { LastDigestIndicator } from './LastDigestIndicator';

const fetchMock = vi.fn();

// SWR caches by key globally; wrap each render in a fresh provider with an
// empty cache so tests don't bleed state into each other.
function renderFresh() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LastDigestIndicator />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('LastDigestIndicator (AC #10)', () => {
  it('renders the relative-time string when lastSentAt is present', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { lastSentAt: fiveDaysAgo } }));

    renderFresh();

    await waitFor(() => {
      expect(screen.getByTestId('last-digest-indicator')).toBeInTheDocument();
    });
    expect(screen.getByTestId('last-digest-indicator').textContent).toMatch(/Last digest sent .*ago/i);
  });

  it('renders nothing when the API returns lastSentAt: null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { lastSentAt: null } }));

    const { container } = renderFresh();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(container.querySelector('[data-testid="last-digest-indicator"]')).toBeNull();
  });

  it('renders nothing when the fetch fails (silent failure)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const { container } = renderFresh();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(container.querySelector('[data-testid="last-digest-indicator"]')).toBeNull();
  });

  it('renders nothing when the API returns a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const { container } = renderFresh();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(container.querySelector('[data-testid="last-digest-indicator"]')).toBeNull();
  });

  it('hits the BFF proxy at /api/digest/last-sent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { lastSentAt: null } }));

    renderFresh();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/digest/last-sent');
    });
  });
});
