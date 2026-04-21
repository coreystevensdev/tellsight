'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

import type { TransparencyMetadata } from 'shared/types';

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'timeout'
  | 'free_preview';

export interface StreamState {
  status: StreamStatus;
  text: string;
  rawText: string;
  metadata: TransparencyMetadata | null;
  error: string | null;
  code: string | null;
  retryable: boolean;
  retryCount: number;
}

import { statTagGlobal, statTagOpenFragment } from 'shared/constants';

// strips complete <stat id="..."/> tokens and hides an incomplete trailing
// tag fragment while the next chunk is still arriving. public for tests.
export function stripStatTags(raw: string): string {
  return raw.replace(statTagGlobal(), '').replace(statTagOpenFragment(), '');
}

export type StreamAction =
  | { type: 'START'; isRetry?: boolean }
  | { type: 'TEXT'; delta: string }
  | { type: 'DONE'; metadata?: TransparencyMetadata | null }
  | { type: 'ERROR'; message: string; code?: string; retryable?: boolean }
  | { type: 'PARTIAL'; text: string; metadata?: TransparencyMetadata | null }
  | { type: 'CACHE_HIT'; content: string; metadata?: TransparencyMetadata | null }
  | { type: 'UPGRADE_REQUIRED'; wordCount: number }
  | { type: 'RESET' };

const initialState: StreamState = {
  status: 'idle',
  text: '',
  rawText: '',
  metadata: null,
  error: null,
  code: null,
  retryable: false,
  retryCount: 0,
};

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'START':
      return {
        ...initialState,
        status: 'connecting',
        retryCount: action.isRetry ? state.retryCount + 1 : 0,
      };
    case 'TEXT': {
      const rawText = state.rawText + action.delta;
      return { ...state, status: 'streaming', rawText, text: stripStatTags(rawText) };
    }
    case 'DONE':
      // after PARTIAL/UPGRADE_REQUIRED, the trailing done is a no-op
      if (state.status === 'timeout' || state.status === 'free_preview') return state;
      return { ...state, status: 'done', metadata: action.metadata ?? null };
    case 'UPGRADE_REQUIRED':
      return { ...state, status: 'free_preview' };
    case 'ERROR':
      return {
        ...state,
        status: 'error',
        error: action.message,
        code: action.code ?? null,
        retryable: action.retryable ?? false,
      };
    case 'PARTIAL':
      return {
        ...state,
        status: 'timeout',
        rawText: action.text,
        text: stripStatTags(action.text),
        metadata: action.metadata ?? null,
      };
    case 'CACHE_HIT':
      return {
        ...initialState,
        status: 'done',
        rawText: action.content,
        text: stripStatTags(action.content),
        metadata: action.metadata ?? null,
      };
    case 'RESET':
      return initialState;
  }
}

function parseSseLines(
  buffer: string,
  dispatch: (action: StreamAction) => void,
): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';

  let currentEvent = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      try {
        const parsed = JSON.parse(raw);
        switch (currentEvent) {
          case 'text':
            dispatch({ type: 'TEXT', delta: parsed.text });
            break;
          case 'done':
            dispatch({ type: 'DONE', metadata: parsed.metadata ?? null });
            break;
          case 'error':
            dispatch({
              type: 'ERROR',
              message: parsed.message ?? 'Stream error',
              code: parsed.code,
              retryable: parsed.retryable ?? false,
            });
            break;
          case 'partial':
            dispatch({ type: 'PARTIAL', text: parsed.text, metadata: parsed.metadata ?? null });
            break;
          case 'upgrade_required':
            dispatch({ type: 'UPGRADE_REQUIRED', wordCount: parsed.wordCount });
            break;
        }
      } catch {
        // malformed JSON — skip
      }
      currentEvent = '';
    }
  }

  return remainder;
}

const MAX_RETRIES = 3;

export function useAiStream(datasetId: number | null) {
  const [state, dispatch] = useReducer(streamReducer, initialState);
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
      const res = await fetch(`/api/ai-summaries/${datasetId}`, {
        signal: controller.signal,
        credentials: 'same-origin',
      });

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

      // cache hit — JSON response
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
