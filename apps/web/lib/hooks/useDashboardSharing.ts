'use client';

import { useCallback, type RefObject } from 'react';

import { useCreateShareLink } from '@/lib/hooks/useCreateShareLink';
import { useExportPdf } from '@/lib/hooks/useExportPdf';
import { useShareInsight } from '@/lib/hooks/useShareInsight';

export function useDashboardSharing(
  captureRef: RefObject<HTMLDivElement | null>,
  datasetId: number | null,
) {
  const {
    status: shareStatus,
    generatePng,
    downloadPng,
    copyToClipboard,
  } = useShareInsight(captureRef);
  const {
    status: linkStatus,
    clipboardFailed: linkClipboardFailed,
    createLink,
  } = useCreateShareLink();
  const { status: pdfStatus, exportPdf } = useExportPdf(captureRef);

  const copyLink = useCallback(async () => {
    if (datasetId != null) await createLink(datasetId);
  }, [datasetId, createLink]);

  return {
    shareStatus,
    generatePng,
    downloadPng,
    copyToClipboard,
    copyLink,
    linkStatus,
    linkClipboardFailed,
    exportPdf,
    pdfStatus,
  };
}
