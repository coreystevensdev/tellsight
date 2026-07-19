import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useStatDetail } from './useStatDetail';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useStatDetail', () => {
  it('starts idle when datasetId or statId is null', () => {
    const { result } = renderHook(() => useStatDetail(null, null));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
  });

  it('transitions loading -> done on a successful fetch', async () => {
    const data = { statType: 'total', value: 100, detail: { kind: 'formula', expression: '$100', terms: [] } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data }),
    } as Response);

    const { result } = renderHook(() => useStatDetail(1, '1:total:Sales:category'));

    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.data).toEqual(data);
    expect(result.current.error).toBeNull();
  });

  it('transitions loading -> error on a failed fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { message: 'This citation is no longer available' } }),
    } as Response);

    const { result } = renderHook(() => useStatDetail(1, '1:total:Sales:category'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('This citation is no longer available');
    expect(result.current.data).toBeNull();
  });

  it('encodes the statId before building the fetch URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    } as Response);

    renderHook(() => useStatDetail(1, '1:total:Travel/Meals:category'));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/ai-summaries/1/stats/1%3Atotal%3ATravel%2FMeals%3Acategory',
        expect.objectContaining({ credentials: 'same-origin' }),
      ),
    );
  });

  it('cancels the stale request when the statId changes', async () => {
    const signals: AbortSignal[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise(() => {}); // never resolves, superseded by the next id
    });

    const { rerender } = renderHook(({ statId }) => useStatDetail(1, statId), {
      initialProps: { statId: 'a' },
    });

    rerender({ statId: 'b' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});
