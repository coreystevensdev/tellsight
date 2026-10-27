'use client';

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { AI_DISCLAIMER, stripAllCiteTags } from 'shared/constants';

import { NUMBER_PATTERN } from './numberPattern';
import { parseCiteBindings } from './parseCiteBindings';

// The service appends the disclaimer to answer text. This renderer supplies a
// styled footer instead, so remove only that exact generated suffix.
function stripTrailingDisclaimer(text: string): string {
  const suffix = `\n\n${AI_DISCLAIMER}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function highlightCitedNumbers(
  text: string,
  citesByNumber: Map<number, string[]> | undefined,
  onOpenCite: (statId: string) => void,
): ReactNode[] {
  const parts = text.split(NUMBER_PATTERN);
  let numberIndex = -1;

  return parts.map((part, index) => {
    if (index % 2 === 0) return <span key={index}>{part}</span>;

    numberIndex++;
    const statIds = citesByNumber?.get(numberIndex) ?? [];

    return (
      <span
        key={index}
        className="font-semibold text-accent-warm"
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {part}
        {statIds.map((statId, citeIndex) => (
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

export function QaAnswerText({
  rawText,
  onOpenCite,
}: {
  rawText: string;
  onOpenCite: (statId: string) => void;
}) {
  const citations = parseCiteBindings(rawText);
  const citesByParagraph = new Map<number, Map<number, string[]>>();
  for (const citation of citations) {
    let byNumber = citesByParagraph.get(citation.paragraphIndex);
    if (!byNumber) {
      byNumber = new Map();
      citesByParagraph.set(citation.paragraphIndex, byNumber);
    }
    const ids = byNumber.get(citation.numberIndex);
    if (ids) ids.push(citation.statId);
    else byNumber.set(citation.numberIndex, [citation.statId]);
  }

  const displayText = stripTrailingDisclaimer(stripAllCiteTags(rawText));
  const paragraphs = displayText.split('\n\n').filter(Boolean);
  // If the model included the disclaimer in its own prose, the service avoids
  // appending another one. Preserve that prose and do not add a duplicate footer.
  const showFooter = !displayText.includes(AI_DISCLAIMER);

  return (
    <>
      <div className="text-[15px] leading-[1.7] text-card-foreground/85 [&>p+p]:mt-[1.1em]">
        {paragraphs.map((paragraph, index) => (
          <p key={index}>
            {highlightCitedNumbers(paragraph, citesByParagraph.get(index), onOpenCite)}
          </p>
        ))}
      </div>
      {showFooter && (
        <p className="mt-3 text-[11px] leading-tight text-muted-foreground">{AI_DISCLAIMER}</p>
      )}
    </>
  );
}
