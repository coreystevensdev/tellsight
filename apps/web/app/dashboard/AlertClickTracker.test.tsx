import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when utm_source is digest, not alert', async () => {
    setSearch({ utm_source: 'digest', t: 'token-abc' });
    render(<AlertClickTracker />);

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when t param is missing', async () => {
    setSearch({ utm_source: 'alert' });
    render(<AlertClickTracker />);

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips POST when sessionStorage flag is set for the token', async () => {
    setSearch({ utm_source: 'alert', t: 'token-already-tracked' });
    window.sessionStorage.setItem('alert_click_tracked_token-already-tracked', '1');

    render(<AlertClickTracker />);

    await new Promise((r) => setTimeout(r, 30));
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
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
