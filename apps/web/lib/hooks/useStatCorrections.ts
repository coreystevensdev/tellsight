'use client';

import { useCallback, useState } from 'react';
import type { StatCorrection } from 'shared/types';

import { useResource } from './useResource';

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
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fetched = useResource(datasetId === null ? null : `stat-corrections:${datasetId}`, async (signal) => {
    const res = await fetch(`/api/stat-corrections/${datasetId}`, { signal, credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
    return (body.data as StatCorrection[]) ?? [];
  });

  // Rows this session has submitted, tagged with the dataset they belong to.
  // They sit on top of the fetched list instead of being merged into it: a
  // correction is additive, and refetching the whole list to show one the user
  // just wrote would make their own note take a round trip to appear. The tag is
  // what stops them leaking onto a different dataset when the drawer moves.
  const [submitted, setSubmitted] = useState<{ datasetId: number | null; rows: StatCorrection[] }>({
    datasetId: null,
    rows: [],
  });
  const mine = submitted.datasetId === datasetId ? submitted.rows : [];
  const corrections = [...mine, ...(fetched.data ?? [])];
  const status: StatCorrectionsStatus = fetched.status;
  const error = fetched.error;

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

        const row = body.data as StatCorrection;
        setSubmitted((prev) =>
          prev.datasetId === datasetId ? { datasetId, rows: [row, ...prev.rows] } : { datasetId, rows: [row] },
        );
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
