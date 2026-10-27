'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { attemptRefresh } from '@/lib/api-client';
import {
  initialStreamState,
  parseSseLines,
  streamReducer,
} from './aiStreamProtocol';

export {
  streamReducer,
  stripCiteTags,
  stripDisplayTags,
  stripStatTags,
} from './aiStreamProtocol';
export type { StreamAction, StreamState, StreamStatus } from './aiStreamProtocol';

const MAX_RETRIES = 3;

export function useAiStream(datasetId: number | null) {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef(state.status);
  useEffect(() => { statusRef.current = state.status; }, [state.status]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const fetchStream = useCallback(async () => {
    if (datasetId === null) return;

    cancel();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const doFetch = () =>
        fetch(`/api/ai-summaries/${datasetId}`, {
          signal: controller.signal,
          credentials: 'same-origin',
        });

      let res = await doFetch();

      // The access token cookie is short-lived and the dashboard can sit open
      // for a while before this fires, silently refresh and retry once rather
      // than surfacing a raw "missing access token" error, same recovery
      // apiClient() already does for every other fetch.
      if (res.status === 401 && (await attemptRefresh())) {
        res = await doFetch();
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errBody = body as { error?: { message?: string; code?: string } };
        dispatch({
          type: 'ERROR',
          message: errBody.error?.message ?? `Request failed (${res.status})`,
          code: errBody.error?.code,
          retryable: res.status >= 500 || res.status === 429,
        });
        return;
      }

      // cache hit, JSON response
      if (res.headers.get('content-type')?.includes('application/json')) {
        const json = await res.json();
        dispatch({ type: 'CACHE_HIT', content: json.data.content, metadata: json.data.metadata ?? null });
        return;
      }

      // SSE stream
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        buffer = parseSseLines(buffer, dispatch);
      }

      if (buffer.trim()) {
        parseSseLines(buffer + '\n', dispatch);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      dispatch({ type: 'ERROR', message: 'Connection failed', retryable: true });
    }
  }, [datasetId, cancel]);

  const start = useCallback(async () => {
    if (datasetId === null) return;
    if (statusRef.current === 'connecting' || statusRef.current === 'streaming') return;
    dispatch({ type: 'START' });
    await fetchStream();
  }, [datasetId, fetchStream]);

  const retry = useCallback(async () => {
    if (datasetId === null) return;
    if (statusRef.current === 'connecting' || statusRef.current === 'streaming') return;
    if (!state.retryable || state.retryCount >= MAX_RETRIES) return;
    dispatch({ type: 'START', isRetry: true });
    await fetchStream();
  }, [datasetId, fetchStream, state.retryable, state.retryCount]);

  // auto-trigger on mount
  useEffect(() => {
    if (datasetId !== null) {
      start();
    }
    return cancel;
  }, [datasetId, start, cancel]);

  return {
    ...state,
    start,
    cancel,
    retry,
    maxRetriesReached: state.retryCount >= MAX_RETRIES,
  };
}
