import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { AlertClickTracker } from './AlertClickTracker';

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

describe('AlertClickTracker', () => {
  it('fires POST /api/track/alert/click when utm_source=alert + t are present', async () => {
    setSearch({ utm_source: 'alert', t: 'token-abc', datasetId: '5' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    render(<AlertClickTracker />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/track/alert/click');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ token: 'token-abc' });
  });

  it('skips POST when utm_source is missing', async () => {
    setSearch({ t: 'token-abc' });
    render(<AlertClickTracker />);

    // No wait: the effect runs to completion inside render's act(), and it
    // returns before reaching fetch. Sleeping here only delayed the same
    // assertion. waitFor would be worse, it passes on the first check and so
    // proves nothing about a call that never happens.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when utm_source is digest, not alert', async () => {
    setSearch({ utm_source: 'digest', t: 'token-abc' });
    render(<AlertClickTracker />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when t param is missing', async () => {
    setSearch({ utm_source: 'alert' });
    render(<AlertClickTracker />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when sessionStorage flag is set for the token', async () => {
    setSearch({ utm_source: 'alert', t: 'token-already-tracked' });
    window.sessionStorage.setItem('alert_click_tracked_token-already-tracked', '1');

    render(<AlertClickTracker />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips t from the URL after a successful POST, preserving other params', async () => {
    setSearch({ utm_source: 'alert', t: 'token-abc', datasetId: '5' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    render(<AlertClickTracker />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    const [path, opts] = mockReplace.mock.calls[0]!;
    expect(path).toContain('/dashboard?');
    expect(path).not.toContain('t=token-abc');
    expect(path).toContain('utm_source=alert');
    expect(path).toContain('datasetId=5');
    expect(opts).toEqual({ scroll: false });
  });

  it('swallows fetch errors silently (no replace), but keeps the dedupe flag', async () => {
    setSearch({ utm_source: 'alert', t: 'token-fail' });
    fetchMock.mockRejectedValueOnce(new Error('network'));

    render(<AlertClickTracker />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});
    expect(mockReplace).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('alert_click_tracked_token-fail')).toBe('1');
  });

  it('does not re-fire on a second mount in the same session (firedRef + sessionStorage dedupe)', async () => {
    setSearch({ utm_source: 'alert', t: 'token-double' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { unmount } = render(<AlertClickTracker />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    render(<AlertClickTracker />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still fires the POST and strips the URL when sessionStorage.getItem throws (Safari private mode)', async () => {
    const getItemSpy = vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    setSearch({ utm_source: 'alert', t: 'token-getitem-throws' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    try {
      render(<AlertClickTracker />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/track/alert/click');
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

    setSearch({ utm_source: 'alert', t: 'token-setitem-throws' });
    fetchMock.mockResolvedValueOnce({ ok: true });

    try {
      render(<AlertClickTracker />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/track/alert/click');
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
