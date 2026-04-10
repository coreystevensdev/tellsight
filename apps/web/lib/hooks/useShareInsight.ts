'use client';

import { useCallback, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { trackClientEvent } from '@/lib/analytics';

type ShareStatus = 'idle' | 'generating' | 'done' | 'error';

interface UseShareInsightOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function useShareInsight(
  nodeRef: React.RefObject<HTMLElement | null>,
  opts: UseShareInsightOptions = {},
) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const [status, setStatus] = useState<ShareStatus>('idle');
  const dataUrlRef = useRef<string | null>(null);

  const generatePng = useCallback(async () => {
    // already generated — skip redundant DOM walk
    if (dataUrlRef.current) return;

    if (!nodeRef.current) {
      setStatus('error');
      throw new Error('Capture node not available');
    }

    setStatus('generating');

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        toPng(nodeRef.current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PNG generation timed out')), timeoutMs);
        }),
      ]);
      clearTimeout(timer);

      dataUrlRef.current = result;
      setStatus('done');
      trackClientEvent(ANALYTICS_EVENTS.INSIGHT_EXPORTED, { format: 'png' });
    } catch {
      clearTimeout(timer);
      setStatus('error');
    }
  }, [nodeRef, timeoutMs]);

  const downloadPng = useCallback(() => {
    if (!dataUrlRef.current) return;

    const link = document.createElement('a');
    link.href = dataUrlRef.current;
    link.download = 'insight.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const copyToClipboard = useCallback(async () => {
    if (!dataUrlRef.current) return;

    // Clipboard API needs a Blob, not a data URL
    const res = await fetch(dataUrlRef.current);
    const blob = await res.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }, []);

  return { status, generatePng, downloadPng, copyToClipboard };
}
