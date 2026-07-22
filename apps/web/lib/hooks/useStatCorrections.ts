'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StatCorrection } from 'shared/types';

export type StatCorrectionsStatus = 'idle' | 'loading' | 'error' | 'done';
export type SubmitStatus = 'idle' | 'submitting' | 'error';

export interface UseStatCorrectionsResult {
  status: StatCorrectionsStatus;
  corrections: StatCorrection[];
  error: string | null;
  submitStatus: SubmitStatus;
  submitError: string | null;
  submitCorrection: (note: string, appliesGoingForward: boolean) => Promise<boolean>;
}

// Fetches every correction for the dataset (not filtered server-side by
// statId), the drawer filters to the open citation's rows itself, so
// re-opening a sibling citation in the same dataset doesn't refetch.
export function useStatCorrections(datasetId: number | null, statId: string | null): UseStatCorrectionsResult {
  const [status, setStatus] = useState<StatCorrectionsStatus>('idle');
  const [corrections, setCorrections] = useState<StatCorrection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (datasetId === null) {
      setStatus('idle');
      setCorrections([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    fetch(`/api/stat-corrections/${datasetId}`, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        setCorrections((body.data as StatCorrection[]) ?? []);
        setStatus('done');
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setStatus('error');
      });

    return () => controller.abort();
  }, [datasetId]);

  const submitCorrection = useCallback(
    async (note: string, appliesGoingForward: boolean) => {
      if (datasetId === null || statId === null) return false;

      setSubmitStatus('submitting');
      setSubmitError(null);

      try {
        const res = await fetch('/api/stat-corrections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ datasetId, statInstanceId: statId, note, appliesGoingForward }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);

        setCorrections((prev) => [body.data as StatCorrection, ...prev]);
        setSubmitStatus('idle');
        return true;
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
        setSubmitStatus('error');
        return false;
      }
    },
    [datasetId, statId],
  );

  return { status, corrections, error, submitStatus, submitError, submitCorrection };
}
