import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockToPng = vi.fn();
vi.mock('html-to-image', () => ({
  toPng: (...args: unknown[]) => mockToPng(...args),
}));

vi.mock('@/lib/analytics', () => ({
  trackClientEvent: vi.fn(),
}));

import { useShareInsight } from './useShareInsight';
import { trackClientEvent } from '@/lib/analytics';

function makeNode(): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = 'chart content';
  document.body.appendChild(el);
  return el;
}

function resetBody() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mockToPng.mockReset();
  vi.mocked(trackClientEvent).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  resetBody();
});

describe('useShareInsight', () => {
  it('starts in idle state', () => {
    const ref = { current: makeNode() };
    const { result } = renderHook(() => useShareInsight(ref));

    expect(result.current.status).toBe('idle');
  });

  it('generates a PNG data URL and transitions to done', async () => {
    const dataUrl = 'data:image/png;base64,abc123';
    mockToPng.mockResolvedValue(dataUrl);
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng();
    });

    expect(result.current.status).toBe('done');
    expect(mockToPng).toHaveBeenCalledWith(ref.current);
  });

  it('transitions through generating state', async () => {
    let resolve: (v: string) => void;
    mockToPng.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    let generatePromise: Promise<void>;
    act(() => {
      generatePromise = result.current.generatePng();
    });

    expect(result.current.status).toBe('generating');

    await act(async () => {
      resolve!('data:image/png;base64,ok');
      await generatePromise!;
    });

    expect(result.current.status).toBe('done');
  });

  it('handles timeout by rejecting after configured ms', async () => {
    mockToPng.mockReturnValue(new Promise(() => {})); // never resolves
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref, { timeoutMs: 500 }));

    let generatePromise: Promise<void>;
    act(() => {
      generatePromise = result.current.generatePng();
    });

    expect(result.current.status).toBe('generating');

    await act(async () => {
      vi.advanceTimersByTime(500);
      await generatePromise!.catch(() => {});
    });

    expect(result.current.status).toBe('error');
  });

  it('sets error state when toPng rejects', async () => {
    mockToPng.mockRejectedValue(new Error('canvas tainted'));
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng().catch(() => {});
    });

    expect(result.current.status).toBe('error');
  });

  it('returns error when ref is null', async () => {
    const ref = { current: null };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng().catch(() => {});
    });

    expect(result.current.status).toBe('error');
  });

  it('downloadPng triggers a download', async () => {
    const dataUrl = 'data:image/png;base64,abc';
    mockToPng.mockResolvedValue(dataUrl);
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng();
    });

    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    const anchor = origCreate('a');
    anchor.click = clickSpy;
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') return anchor;
      return origCreate(tag);
    });

    act(() => {
      result.current.downloadPng();
    });

    expect(anchor.download).toBe('insight.png');
    expect(clickSpy).toHaveBeenCalled();

    createSpy.mockRestore();
  });

  it('skips regeneration when PNG is already cached', async () => {
    mockToPng.mockResolvedValue('data:image/png;base64,first');
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng();
    });
    expect(mockToPng).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.generatePng();
    });
    // still only 1 call, cached
    expect(mockToPng).toHaveBeenCalledTimes(1);
  });

  it('copyToClipboard writes PNG blob to clipboard', async () => {
    const dataUrl = 'data:image/png;base64,abc';
    mockToPng.mockResolvedValue(dataUrl);
    const ref = { current: makeNode() };

    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { write: mockWrite },
    });

    // jsdom has no ClipboardItem, stub it
    globalThis.ClipboardItem = vi.fn().mockImplementation((items) => items) as unknown as typeof ClipboardItem;

    // mock fetch for data URL to blob conversion
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      blob: () => Promise.resolve(blob),
    } as Response);

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng();
    });

    await act(async () => {
      await result.current.copyToClipboard();
    });

    expect(mockWrite).toHaveBeenCalled();
    vi.mocked(globalThis.fetch).mockRestore();
  });

  it('fires insight.exported analytics event on successful generate', async () => {
    mockToPng.mockResolvedValue('data:image/png;base64,ok');
    const ref = { current: makeNode() };

    const { result } = renderHook(() => useShareInsight(ref));

    await act(async () => {
      await result.current.generatePng();
    });

    expect(trackClientEvent).toHaveBeenCalledWith('insight.exported', { format: 'png' });
  });
});
