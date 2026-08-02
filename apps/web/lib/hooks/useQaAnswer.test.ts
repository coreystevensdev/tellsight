import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useQaAnswer } from './useQaAnswer';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockAnswer = {
  answer: 'Revenue grew 12% this quarter.',
  citedStatIds: ['7:total:Sales:category'],
  termination: 'answered' as const,
  turnCount: 1,
};

describe('useQaAnswer', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useQaAnswer(7));
    expect(result.current.status).toBe('idle');
    expect(result.current.answer).toBeNull();
  });

  it('transitions asking -> answered on a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: mockAnswer }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));

    act(() => {
      void result.current.ask('How did revenue trend?');
    });
    expect(result.current.status).toBe('asking');

    await waitFor(() => expect(result.current.status).toBe('answered'));
    expect(result.current.answer).toEqual(mockAnswer);
    expect(result.current.error).toBeNull();
  });

  it('posts to /api/qa/:datasetId with the question body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: mockAnswer }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How did revenue trend?');
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/qa/7',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ question: 'How did revenue trend?' }),
        credentials: 'same-origin',
      }),
    );
  });

  it('transitions to locked on a 403 response, without surfacing it as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'AGENT_TIER_REQUIRED', message: 'Upgrade required' } }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('locked');
    expect(result.current.error).toBeNull();
  });

  it('transitions to error on a 500 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: 'QA_LOOP_FAILED', message: 'Failed to answer the question' } }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.code).toBe('QA_LOOP_FAILED');
    expect(result.current.error).toBe('Failed to answer the question');
  });

  it('transitions to error when the fetch itself rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Connection failed');
  });

  it('does not surface an AbortError as an error state', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('asking');
  });

  it('aborts the in-flight request on unmount without throwing', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal!;
      return new Promise(() => {});
    });

    const { result, unmount } = renderHook(() => useQaAnswer(7));
    act(() => {
      void result.current.ask('How is my runway?');
    });

    expect(() => unmount()).not.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does not lock on a 403 that is not the agent-tier gate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: 'Not your org' } }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.code).toBe('FORBIDDEN');
  });

  it('surfaces an error when a 2xx response has no data payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ error: { code: 'UPSTREAM_ERROR', message: 'Unexpected response' } }),
    } as Response);

    const { result } = renderHook(() => useQaAnswer(7));
    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.code).toBe('UPSTREAM_ERROR');
  });

  it('aborts and clears the answer when the dataset switches mid-question', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal!;
      return new Promise(() => {});
    });

    const { result, rerender } = renderHook(({ id }) => useQaAnswer(id), { initialProps: { id: 7 } });
    act(() => {
      void result.current.ask('How is my runway?');
    });
    expect(result.current.status).toBe('asking');

    rerender({ id: 8 });

    expect(capturedSignal?.aborted).toBe(true);
    expect(result.current.status).toBe('idle');
    expect(result.current.answer).toBeNull();
  });

  // Confirms abortOwnerRef's gate isn't a one-shot latch -- it must keep
  // aborting on every subsequent switch, not just the first. The exact
  // cross-dataset clobber the gate exists to prevent needs a commit/passive-
  // effect-flush gap that testing-library's synchronous act()-wrapped
  // rerender collapses, so it can't be reproduced here.
  it('keeps aborting and resetting across a second dataset switch', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise(() => {});
    });

    const { result, rerender } = renderHook(({ id }) => useQaAnswer(id), { initialProps: { id: 7 } });
    act(() => {
      void result.current.ask('How is my runway?');
    });

    rerender({ id: 8 });
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.status).toBe('idle');

    act(() => {
      void result.current.ask('How is cash flow?');
    });
    expect(result.current.status).toBe('asking');

    rerender({ id: 9 });

    expect(signals[1]?.aborted).toBe(true);
    expect(result.current.status).toBe('idle');
    expect(result.current.answer).toBeNull();
  });

  it('ignores a stale response from a superseded ask() call (regression)', async () => {
    let resolveFirst: (value: Response) => void = () => {};
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => firstFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { ...mockAnswer, answer: 'second answer' } }),
      } as Response);

    const { result } = renderHook(() => useQaAnswer(7));

    act(() => {
      void result.current.ask('first question');
    });
    await act(async () => {
      await result.current.ask('second question');
    });
    expect(result.current.answer?.answer).toBe('second answer');

    // The superseded first fetch finally resolves after the second call
    // already settled state -- it must not clobber the newer answer.
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { ...mockAnswer, answer: 'first answer (stale)' } }),
      } as Response);
      await Promise.resolve();
    });

    expect(result.current.answer?.answer).toBe('second answer');
  });

  it('does nothing when datasetId is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useQaAnswer(null));

    await act(async () => {
      await result.current.ask('How is my runway?');
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});
