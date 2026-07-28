'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { QaAnswer } from 'shared/types';

export type QaAnswerStatus = 'idle' | 'asking' | 'answered' | 'locked' | 'error';

export interface QaAnswerState {
  status: QaAnswerStatus;
  answer: QaAnswer | null;
  error: string | null;
  code: string | null;
}

const initialState: QaAnswerState = {
  status: 'idle',
  answer: null,
  error: null,
  code: null,
};

// No delta callback exists on the API side (runQaLoop resolves once), so this
// is a plain request/response lifecycle, not a stream reducer -- see useAiStream
// for the pattern this is deliberately smaller than. Every transition below
// replaces the whole state rather than folding onto the previous one, so
// plain useState is enough, no reducer needed.
export function useQaAnswer(datasetId: number | null) {
  const [state, setState] = useState<QaAnswerState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(async (question: string) => {
    if (datasetId === null) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...initialState, status: 'asking' });

    try {
      const res = await fetch(`/api/qa/${datasetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: controller.signal,
        credentials: 'same-origin',
      });

      const body = await res.json().catch(() => ({}));
      // A newer ask() call may have superseded this one (aborted this
      // controller and started its own) between the fetch resolving and the
      // body finishing parsing -- don't let a stale response clobber it.
      if (abortRef.current !== controller) return;

      const errBody = body as { error?: { message?: string; code?: string } };

      if (res.status === 403 && errBody.error?.code === 'AGENT_TIER_REQUIRED') {
        setState({ status: 'locked', answer: null, error: null, code: null });
        return;
      }

      // Also guards a 2xx response whose body doesn't actually carry `data`
      // (the web proxy falls back to an error-shaped body on a JSON parse
      // failure but can't always downgrade the upstream status alongside it).
      const data = (body as { data?: QaAnswer }).data;
      if (!res.ok || !data) {
        setState({
          status: 'error',
          answer: null,
          error: errBody.error?.message ?? `Request failed (${res.status})`,
          code: errBody.error?.code ?? null,
        });
        return;
      }

      setState({ status: 'answered', answer: data, error: null, code: null });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (abortRef.current !== controller) return;
      setState({ status: 'error', answer: null, error: 'Connection failed', code: null });
    }
  }, [datasetId]);

  // Abort an in-flight request and drop any answer tied to the previous
  // dataset whenever the dataset switches, not only on unmount -- same
  // intent as streamToSSE's disconnect handling on the server side.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      setState(initialState);
    };
  }, [datasetId]);

  return { ...state, ask };
}
