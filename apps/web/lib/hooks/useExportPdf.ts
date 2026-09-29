'use client';

import { useCallback, useState } from 'react';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { trackClientEvent } from '@/lib/analytics';

type PdfStatus = 'idle' | 'generating' | 'done' | 'error';

export function useExportPdf(nodeRef: React.RefObject<HTMLElement | null>) {
  const [status, setStatus] = useState<PdfStatus>('idle');

  const exportPdf = useCallback(async () => {
    if (!nodeRef.current) {
      setStatus('error');
      return;
    }

    setStatus('generating');

    try {
      const [{ toPng }, { jsPDF }] = await Promise.all([
        import('html-to-image'),
        import('jspdf'),
      ]);

      const imgData = await toPng(nodeRef.current, { pixelRatio: 2 });

      // decode the PNG to get dimensions for PDF layout
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = imgData;
      });

      // jsPDF embeds the bitmap raw without this, and the live dashboard came
      // back as a 35.5 MB download: exactly its pixel count times four.
      // Measured on a real 1792x4947 capture: NONE 26.6 MB, FAST 0.57 MB,
      // MEDIUM 0.55 MB, SLOW 0.50 MB for twice the time. jsPDF already stores
      // one copy however many pages reference it, so no alias is needed.
      const compression = 'FAST';

      const imgWidth = 190; // A4 width minus margins (210 - 10 - 10)
      const imgHeight = (img.height * imgWidth) / img.width;
      const pageHeight = 277; // A4 height minus margins (297 - 10 - 10)

      const pdf = new jsPDF('p', 'mm', 'a4');
      let yOffset = 10;
      let remainingHeight = imgHeight;

      // first page
      pdf.addImage(imgData, 'PNG', 10, yOffset, imgWidth, imgHeight, undefined, compression);
      remainingHeight -= pageHeight;

      // additional pages if content overflows
      while (remainingHeight > 0) {
        pdf.addPage();
        yOffset = -(imgHeight - remainingHeight) + 10;
        pdf.addImage(imgData, 'PNG', 10, yOffset, imgWidth, imgHeight, undefined, compression);
        remainingHeight -= pageHeight;
      }

      pdf.save('tellsight-report.pdf');
      setStatus('done');
      trackClientEvent(ANALYTICS_EVENTS.INSIGHT_EXPORTED, { format: 'pdf' });
    } catch {
      setStatus('error');
    }
  }, [nodeRef]);

  return { status, exportPdf };
}
