import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({
  trackClientEvent: vi.fn(),
}));

import { useCreateShareLink } from './useCreateShareLink';
import { trackClientEvent } from '@/lib/analytics';

const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('useCreateShareLink', () => {
  it('starts in idle state with no URL', () => {
    const { result } = renderHook(() => useCreateShareLink());

    expect(result.current.status).toBe('idle');
    expect(result.current.shareUrl).toBeNull();
  });

  it('creates a share link, copies to clipboard, and transitions to done', async () => {
    const shareData = { url: 'http://localhost:3000/share/abc123', token: 'abc123', expiresAt: '2026-04-24' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: shareData }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(result.current.status).toBe('done');
    expect(result.current.shareUrl).toBe(shareData.url);
    expect(mockWriteText).toHaveBeenCalledWith(shareData.url);
  });

  it('calls POST /api/shares with correct body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { url: 'http://x/share/t' } }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(7);
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/shares', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ datasetId: 7 }),
    }));
  });

  it('fires SHARE_LINK_CREATED analytics event on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { url: 'http://x/share/t' } }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(trackClientEvent).toHaveBeenCalledWith('share_link.created', { datasetId: 5 });
  });

  it('still transitions to done and exposes URL when clipboard fails', async () => {
    mockWriteText.mockRejectedValueOnce(new Error('Clipboard permission denied'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { url: 'http://localhost:3000/share/abc' } }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(result.current.status).toBe('done');
    expect(result.current.shareUrl).toBe('http://localhost:3000/share/abc');
    expect(result.current.clipboardFailed).toBe(true);
  });

  it('exposes error message from API on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: 'No cached summary' } }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorMsg).toBe('No cached summary');
  });

  it('transitions to error on API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: 'No summary' } }),
    } as Response);

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.shareUrl).toBeNull();
  });

  it('transitions to error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useCreateShareLink());

    await act(async () => {
      await result.current.createLink(5);
    });

    expect(result.current.status).toBe('error');
  });
});
