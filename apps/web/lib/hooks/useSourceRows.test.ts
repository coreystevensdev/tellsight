import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSourceRows } from './useSourceRows';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSourceRows', () => {
  it('starts idle when datasetId or statId is null', () => {
    const { result } = renderHook(() => useSourceRows(null, null, 1));
    expect(result.current.status).toBe('idle');
    expect(result.current.rows).toEqual([]);
    expect(result.current.meta).toBeNull();
  });

  it('transitions loading -> done on a successful fetch', async () => {
    const data = [{ id: 1, date: '2026-01-01', category: 'Sales', parentCategory: null, amount: '100.00', label: null }];
    const meta = { total: 1, pagination: { page: 1, pageSize: 25, totalPages: 1 } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data, meta }),
    } as Response);

    const { result } = renderHook(() => useSourceRows(1, '1:total:Sales:category', 1));

    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.rows).toEqual(data);
    expect(result.current.meta).toEqual(meta);
    expect(result.current.error).toBeNull();
  });

  it('transitions loading -> error on a failed fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { message: 'This citation is no longer available' } }),
    } as Response);

    const { result } = renderHook(() => useSourceRows(1, '1:total:Sales:category', 1));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('This citation is no longer available');
    expect(result.current.rows).toEqual([]);
  });

  it('encodes the statId and forwards limit/offset for the current page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [], meta: { total: 0, pagination: { page: 3, pageSize: 25, totalPages: 3 } } }),
    } as Response);

    renderHook(() => useSourceRows(1, '1:total:Travel/Meals:category', 3));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/ai-summaries/1/stats/1%3Atotal%3ATravel%2FMeals%3Acategory/rows?limit=25&offset=50',
        expect.objectContaining({ credentials: 'same-origin' }),
      ),
    );
  });

  it('cancels the stale request when the page changes', async () => {
    const signals: AbortSignal[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise(() => {}); // never resolves, superseded by the next page
    });

    const { rerender } = renderHook(({ page }) => useSourceRows(1, '1:total:Sales:category', page), {
      initialProps: { page: 1 },
    });

    rerender({ page: 2 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});
