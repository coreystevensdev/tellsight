'use client';

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

import { InsightChartChip } from './InsightChartChip';
import { InsightChartThumbnail } from './InsightChartThumbnail';
import { NUMBER_PATTERN } from './numberPattern';
import type { CiteBinding } from './parseCiteBindings';
import type { StatBinding } from './parseStatBindings';
import type { CashBalancePoint } from './charts/RunwayTrendChart';

interface SummaryTextProps {
  text: string;
  bindings?: StatBinding[];
  citations?: CiteBinding[];
  onOpenStat?: (statId: string, paragraphIndex: number) => void;
  onOpenCite?: (statId: string) => void;
  cashHistory?: CashBalancePoint[];
  cashForecast?: CashBalancePoint[];
  isMobile?: boolean;
}

function highlightNumbers(
  text: string,
  citesByNumber?: Map<number, string[]>,
  onOpenCite?: (statId: string) => void,
): ReactNode[] {
  // NUMBER_PATTERN has one capture group, so even split indices are prose and
  // odd indices are matched numbers. This also avoids shared /g lastIndex state.
  const parts = text.split(NUMBER_PATTERN);
  let numberIndex = -1;

  return parts.map((part, index) => {
    if (index % 2 === 0) return <span key={index}>{part}</span>;

    numberIndex++;
    const statIds = citesByNumber?.get(numberIndex) ?? [];

    return (
      <span key={index} className="font-mono font-medium text-accent-warm">
        {part}
        {onOpenCite &&
          statIds.map((statId, citeIndex) => (
            <button
              key={`${statId}-${citeIndex}`}
              type="button"
              onClick={() => onOpenCite(statId)}
              className="ml-0.5 inline-flex h-3.5 w-3.5 align-super text-accent-warm/60 hover:text-accent-warm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-warm"
              aria-label={
                statIds.length > 1
                  ? `Show how ${part} was calculated (source ${citeIndex + 1} of ${statIds.length})`
                  : `Show how ${part} was calculated`
              }
            >
              <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
          ))}
      </span>
    );
  });
}

export function SummaryText({
  text,
  bindings,
  citations,
  onOpenStat,
  onOpenCite,
  cashHistory,
  cashForecast,
  isMobile,
}: SummaryTextProps) {
  const paragraphs = text.split('\n\n').filter(Boolean);
  const bindingByIndex = new Map<number, string>();
  for (const binding of bindings ?? []) {
    bindingByIndex.set(binding.paragraphIndex, binding.statId);
  }

  // A number may have multiple consecutive citations, so each number maps to
  // an array of source stat IDs rather than a single source.
  const citesByParagraph = new Map<number, Map<number, string[]>>();
  for (const citation of citations ?? []) {
    let byNumber = citesByParagraph.get(citation.paragraphIndex);
    if (!byNumber) {
      byNumber = new Map();
      citesByParagraph.set(citation.paragraphIndex, byNumber);
    }
    const ids = byNumber.get(citation.numberIndex);
    if (ids) ids.push(citation.statId);
    else byNumber.set(citation.numberIndex, [citation.statId]);
  }

  return (
    <div className="font-serif text-[15px] leading-[1.7] text-card-foreground/85 md:text-base md:leading-[1.75] [&>p+p]:mt-[1.1em]">
      {paragraphs.flatMap((paragraph, index) => {
        const statId = bindingByIndex.get(index);
        const paragraphCites = citesByParagraph.get(index);
        const elements = [
          <p
            key={index}
            className={
              index === 0
                ? 'text-card-foreground font-medium first-letter:float-left first-letter:mr-1 first-letter:font-serif first-letter:text-[2.6em] first-letter:font-medium first-letter:leading-[0.8] first-letter:text-primary'
                : undefined
            }
          >
            {highlightNumbers(paragraph, paragraphCites, onOpenCite)}
          </p>,
        ];

        // A thumbnail gets its own paragraph so prose never wraps around the
        // fixed-size chart unpredictably.
        if (statId && onOpenStat) {
          elements.push(
            <p key={`${index}-chart`}>
              {isMobile ? (
                <InsightChartChip statId={statId} onOpen={() => onOpenStat(statId, index)} />
              ) : (
                <InsightChartThumbnail
                  statId={statId}
                  cashHistory={cashHistory}
                  cashForecast={cashForecast}
                  onOpen={() => onOpenStat(statId, index)}
                />
              )}
            </p>,
          );
        }

        return elements;
      })}
    </div>
  );
}
