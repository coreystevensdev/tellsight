'use client';

import { useCallback, useState } from 'react';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { trackClientEvent } from '@/lib/analytics';

type LinkStatus = 'idle' | 'creating' | 'done' | 'error';

const TIMEOUT_MS = 10_000;

export function useCreateShareLink() {
  const [status, setStatus] = useState<LinkStatus>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [clipboardFailed, setClipboardFailed] = useState(false);

  const createLink = useCallback(async (datasetId: number) => {
    setStatus('creating');
    setShareUrl(null);
    setErrorMsg(null);
    setClipboardFailed(false);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId }),
        credentials: 'same-origin',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }

      const { data } = (await res.json()) as { data: { url: string } };

      // commit the URL before attempting clipboard, the share exists in the DB
      setShareUrl(data.url);
      setStatus('done');
      trackClientEvent(ANALYTICS_EVENTS.SHARE_LINK_CREATED, { datasetId });

      try {
        await navigator.clipboard.writeText(data.url);
      } catch {
        setClipboardFailed(true);
      }
    } catch (err) {
      clearTimeout(timer);
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong');
      setStatus('error');
    }
  }, []);

  return { status, shareUrl, errorMsg, clipboardFailed, createLink };
}
