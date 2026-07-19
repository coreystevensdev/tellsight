import { citeTagCapture } from 'shared/constants';
import { NUMBER_PATTERN } from './numberPattern';

export interface CiteBinding {
  paragraphIndex: number;
  numberIndex: number;
  statId: string;
}

// One combined pattern instead of two separate passes: a category name that
// happens to look like a number (e.g. a CSV row literally named "50% Off")
// would otherwise get re-matched as a phantom number from inside the cite
// tag's own id attribute, shifting numberIndex and silently dropping the
// real citation. Matching both alternatives in a single left-to-right walk
// means a matched <cite> tag is consumed whole and its interior is never
// independently re-scanned.
const NUMBER_OR_CITE = new RegExp(`${NUMBER_PATTERN.source}|${citeTagCapture().source}`, 'g');

// Parses the raw summary buffer (tags intact) into paragraph/number-indexed
// citation bindings. A tag binds to a number only when nothing but
// whitespace sits between them, that's what "immediately follows" means.
export function parseCiteBindings(rawText: string): CiteBinding[] {
  const paragraphs = rawText.split('\n\n').filter(Boolean);
  const bindings: CiteBinding[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];
    if (!paragraph) continue;

    let numberIndex = -1;
    let lastNumberEnd = -1;

    for (const match of paragraph.matchAll(NUMBER_OR_CITE)) {
      const [full, numberGroup, citeId] = match;
      if (numberGroup !== undefined) {
        numberIndex++;
        lastNumberEnd = match.index! + full.length;
        continue;
      }
      if (citeId === undefined || numberIndex < 0) continue;

      const between = paragraph.slice(lastNumberEnd, match.index!);
      if (/^\s*$/.test(between)) {
        bindings.push({ paragraphIndex: p, numberIndex, statId: citeId });
      }
    }
  }

  return bindings;
}
