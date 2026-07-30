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
// whitespace sits between them, that's what "immediately follows" means,
// checked in both directions since stripInvalidCiteRefs can leave a
// normalized self-closing tag sitting before its number instead of after.
// A repeated id at the same numberIndex binds once, whichever direction it
// came from, so an LLM emitting the same source twice for one number doesn't
// render two identical citation buttons.
export function parseCiteBindings(rawText: string): CiteBinding[] {
  const paragraphs = rawText.split('\n\n').filter(Boolean);
  const bindings: CiteBinding[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];
    if (!paragraph) continue;

    let numberIndex = -1;
    let lastConsumedEnd = -1;
    // tags that missed backward binding wait here for the next number,
    // same adjacency rule; a non-adjacent tag or number drops the whole
    // pending chain, not just the tag that broke it, since a dropped tag
    // means none of the ids before it ever resolved either.
    let pendingIds: string[] = [];
    let pendingEnd = -1;

    // A per-paragraph citation count stays in the tens at most, so the
    // linear scan here over an already-small bindings array is cheap.
    const bind = (statId: string) => {
      const alreadyBound = bindings.some(
        (b) => b.paragraphIndex === p && b.numberIndex === numberIndex && b.statId === statId,
      );
      if (!alreadyBound) bindings.push({ paragraphIndex: p, numberIndex, statId });
    };

    for (const match of paragraph.matchAll(NUMBER_OR_CITE)) {
      const [full, numberGroup, citeId] = match;
      const start = match.index!;
      const end = start + full.length;

      if (numberGroup !== undefined) {
        numberIndex++;
        if (pendingIds.length > 0 && /^\s*$/.test(paragraph.slice(pendingEnd, start))) {
          for (const id of pendingIds) bind(id);
        }
        pendingIds = [];
        lastConsumedEnd = end;
        continue;
      }

      if (!citeId) continue;

      if (numberIndex >= 0 && /^\s*$/.test(paragraph.slice(lastConsumedEnd, start))) {
        bind(citeId);
        // advance past this tag too, so a second <cite> right after the first
        // still counts as "immediately follows" instead of measuring distance
        // back to the number and getting rejected.
        lastConsumedEnd = end;
        continue;
      }

      if (pendingIds.length > 0 && /^\s*$/.test(paragraph.slice(pendingEnd, start))) {
        pendingIds.push(citeId);
      } else {
        pendingIds = [citeId];
      }
      pendingEnd = end;
    }
  }

  return bindings;
}
