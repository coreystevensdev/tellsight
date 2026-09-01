import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { DigestClickTracker } from './DigestClickTracker';

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/dashboard',
  useSearchParams: () => mockSearchParams,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  mockReplace.mockReset();
  // reset URLSearchParams state without reassigning the binding
  for (const key of Array.from(mockSearchParams.keys())) {
    mockSearchParams.delete(key);
  }
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setSearch(params: Record<string, string>) {
  for (const [key, value] of Object.entries(params)) {
    mockSearchParams.set(key, value);
  }
}

describe('DigestClickTracker (AC #2)', () => {
  it('fires POST /api/track/digest/click when utm_source=digest + t are present', async () => {
    setSearch({ utm_source: 'digest', t: 'token-abc', datasetId: '5' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    render(<DigestClickTracker />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/track/digest/click');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ token: 'token-abc' });
  });

  it('skips POST when utm_source is missing', async () => {
    setSearch({ t: 'token-abc' });
    render(<DigestClickTracker />);

    // No wait: the effect runs to completion inside render's act(), and it
    // returns before reaching fetch. Sleeping here only delayed the same
    // assertion. waitFor would be worse, it passes on the first check and so
    // proves nothing about a call that never happens.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when t param is missing', async () => {
    setSearch({ utm_source: 'digest' });
    render(<DigestClickTracker />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when sessionStorage flag is set for the token', async () => {
    setSearch({ utm_source: 'digest', t: 'token-already-tracked' });
    window.sessionStorage.setItem('digest_click_tracked_token-already-tracked', '1');

    render(<DigestClickTracker />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips t from the URL after a successful POST, preserving other params', async () => {
    setSearch({ utm_source: 'digest', t: 'token-abc', datasetId: '5' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    render(<DigestClickTracker />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    const [path, opts] = mockReplace.mock.calls[0]!;
    expect(path).toContain('/dashboard?');
    expect(path).not.toContain('t=token-abc');
    expect(path).toContain('utm_source=digest');
    expect(path).toContain('datasetId=5');
    expect(opts).toEqual({ scroll: false });
  });

  it('marks sessionStorage flag synchronously when the POST is fired', async () => {
    setSearch({ utm_source: 'digest', t: 'token-xyz' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    render(<DigestClickTracker />);

    // Flag set BEFORE the fetch resolves so a fast remount (StrictMode dev,
    // mobile/desktop flip) sees it and skips.
    await waitFor(() => {
      expect(window.sessionStorage.getItem('digest_click_tracked_token-xyz')).toBe('1');
    });
  });

  it('swallows fetch errors silently (no replace), but keeps the dedupe flag', async () => {
    setSearch({ utm_source: 'digest', t: 'token-fail' });
    fetchMock.mockRejectedValueOnce(new Error('network'));

    render(<DigestClickTracker />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});
    expect(mockReplace).not.toHaveBeenCalled();
    // Dedupe flag stays set even on failure: this metric is lossy (Apple MPP,
    // ad blockers) and duplicate analytics rows are worse than a missed retry.
    expect(window.sessionStorage.getItem('digest_click_tracked_token-fail')).toBe('1');
  });

  it('does not re-fire on a second mount in the same session (firedRef + sessionStorage dedupe)', async () => {
    setSearch({ utm_source: 'digest', t: 'token-double' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { unmount } = render(<DigestClickTracker />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    // Mount a second time with the same token still in URL: must NOT re-POST
    render(<DigestClickTracker />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still fires the POST and strips the URL when sessionStorage.getItem throws (Safari private mode)', async () => {
    const getItemSpy = vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    setSearch({ utm_source: 'digest', t: 'token-getitem-throws' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    try {
      render(<DigestClickTracker />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/track/digest/click');
      expect(JSON.parse(init.body)).toEqual({ token: 'token-getitem-throws' });

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledTimes(1);
      });
      expect(mockReplace.mock.calls[0]![0]).not.toContain('t=token-getitem-throws');
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('still fires the POST and strips the URL when sessionStorage.setItem throws (Safari private mode)', async () => {
    const setItemSpy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    setSearch({ utm_source: 'digest', t: 'token-setitem-throws' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    try {
      render(<DigestClickTracker />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/track/digest/click');
      expect(JSON.parse(init.body)).toEqual({ token: 'token-setitem-throws' });

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledTimes(1);
      });
      expect(mockReplace.mock.calls[0]![0]).not.toContain('t=token-setitem-throws');
    } finally {
      setItemSpy.mockRestore();
    }
  });
});
