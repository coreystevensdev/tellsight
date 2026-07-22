import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useStatCorrections } from './useStatCorrections';

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleCorrection = {
  id: 1,
  datasetId: 7,
  statInstanceId: '7:runway:_:_',
  note: 'Double-counts the SBA loan',
  appliesGoingForward: false,
  status: null,
  createdAt: '2026-07-22T00:00:00.000Z',
  expiresAt: null,
};

describe('useStatCorrections', () => {
  it('starts idle when datasetId is null', () => {
    const { result } = renderHook(() => useStatCorrections(null, null));
    expect(result.current.status).toBe('idle');
    expect(result.current.corrections).toEqual([]);
  });

  it('fetches corrections for the dataset on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [sampleCorrection] }),
    } as Response);

    const { result } = renderHook(() => useStatCorrections(7, '7:runway:_:_'));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.corrections).toEqual([sampleCorrection]);
  });

  it('transitions to error when the fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Something broke' } }),
    } as Response);

    const { result } = renderHook(() => useStatCorrections(7, '7:runway:_:_'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Something broke');
  });

  it('submitCorrection posts the note and prepends the new row on success', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: sampleCorrection }) } as Response);

    const { result } = renderHook(() => useStatCorrections(7, '7:runway:_:_'));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let ok = false;
    await act(async () => {
      ok = await result.current.submitCorrection('Double-counts the SBA loan', false);
    });

    expect(ok).toBe(true);
    expect(result.current.corrections).toEqual([sampleCorrection]);
    expect(result.current.submitStatus).toBe('idle');
  });

  it('submitCorrection sends appliesGoingForward through to the request body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { ...sampleCorrection, appliesGoingForward: true, status: 'pending' } }),
      } as Response);

    const { result } = renderHook(() => useStatCorrections(7, '7:runway:_:_'));
    await waitFor(() => expect(result.current.status).toBe('done'));

    await act(async () => {
      await result.current.submitCorrection('apply this forever', true);
    });

    expect(fetchSpy).toHaveBeenLastCalledWith('/api/stat-corrections', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ datasetId: 7, statInstanceId: '7:runway:_:_', note: 'apply this forever', appliesGoingForward: true }),
    }));
  });

  it('submitCorrection surfaces the server error and leaves the list untouched', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: { message: 'A pending or approved correction already exists for this stat' } }),
      } as Response);

    const { result } = renderHook(() => useStatCorrections(7, '7:runway:_:_'));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let ok = true;
    await act(async () => {
      ok = await result.current.submitCorrection('note', true);
    });

    expect(ok).toBe(false);
    expect(result.current.submitStatus).toBe('error');
    expect(result.current.submitError).toBe('A pending or approved correction already exists for this stat');
    expect(result.current.corrections).toEqual([]);
  });

  it('submitCorrection is a no-op when statId is null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response);

    const { result } = renderHook(() => useStatCorrections(7, null));

    let ok = true;
    await act(async () => {
      ok = await result.current.submitCorrection('note', false);
    });

    expect(ok).toBe(false);
  });
});
