'use client';

import { useMemo, useState } from 'react';

import { ANALYTICS_EVENTS } from 'shared/constants';
import { trackClientEvent } from '@/lib/analytics';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { stripDisplayTags } from '@/lib/hooks/useAiStream';
import { InsightChartSheet } from './InsightChartSheet';
import { parseCiteBindings, type CiteBinding } from './parseCiteBindings';
import { parseStatBindings, type StatBinding } from './parseStatBindings';
import { StatDetailSheet } from './StatDetailSheet';
import type { CashBalancePoint } from './charts/RunwayTrendChart';

export function useAiSummaryDetails(sourceText: string, ready: boolean) {
  const isMobile = useIsMobile();
  const [openStatId, setOpenStatId] = useState<string | null>(null);
  const [openParagraphText, setOpenParagraphText] = useState('');
  const [openCiteId, setOpenCiteId] = useState<string | null>(null);

  const bindings = useMemo<StatBinding[]>(
    () => (ready ? parseStatBindings(sourceText) : []),
    [ready, sourceText],
  );
  const citations = useMemo<CiteBinding[]>(
    () => (ready ? parseCiteBindings(sourceText) : []),
    [ready, sourceText],
  );

  const openStat = (statId: string, paragraphIndex: number) => {
    const paragraphs = stripDisplayTags(sourceText).split('\n\n').filter(Boolean);
    setOpenStatId(statId);
    setOpenParagraphText(paragraphs[paragraphIndex] ?? '');
    trackClientEvent(ANALYTICS_EVENTS.INSIGHT_CHART_OPENED, {
      statType: statId,
      paragraphIndex,
      viewport: isMobile ? 'mobile' : 'desktop',
    });
  };

  return {
    bindings,
    citations,
    isMobile,
    openStat,
    openCite: setOpenCiteId,
    openStatId,
    openParagraphText,
    openCiteId,
    closeStat: () => setOpenStatId(null),
    closeCite: () => setOpenCiteId(null),
  };
}

interface AiSummaryDetailSheetsProps {
  datasetId: number | null;
  openStatId: string | null;
  openParagraphText: string;
  openCiteId: string | null;
  closeStat: () => void;
  closeCite: () => void;
  cashHistory?: CashBalancePoint[];
  cashForecast?: CashBalancePoint[];
}

export function AiSummaryDetailSheets({
  datasetId,
  openStatId,
  openParagraphText,
  openCiteId,
  closeStat,
  closeCite,
  cashHistory,
  cashForecast,
}: AiSummaryDetailSheetsProps) {
  return (
    <>
      <InsightChartSheet
        open={openStatId !== null}
        onOpenChange={(open) => !open && closeStat()}
        statId={openStatId}
        paragraphText={openParagraphText}
        cashHistory={cashHistory}
        cashForecast={cashForecast}
      />
      <StatDetailSheet
        open={openCiteId !== null}
        onOpenChange={(open) => !open && closeCite()}
        datasetId={datasetId}
        statId={openCiteId}
      />
    </>
  );
}
