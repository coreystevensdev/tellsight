import { statTagCapture } from 'shared/constants';

export interface StatBinding {
  paragraphIndex: number;
  statId: string;
}

// extracts paragraph→stat bindings from summary text. runs post-stream on
// the raw buffer (tags intact). validation of statId against the active
// ComputedStat[] lives in validateStatRefs, this parser just reports what
// the LLM emitted.
export function parseStatBindings(rawText: string): StatBinding[] {
  const paragraphs = rawText.split('\n\n').filter(Boolean);
  const bindings: StatBinding[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (!paragraph) continue;
    // matchAll returns a fresh iterator each call so /g lastIndex state
    // can't leak across iterations. We only want the first match per paragraph.
    const first = paragraph.matchAll(statTagCapture()).next();
    if (!first.done && first.value[1]) {
      bindings.push({ paragraphIndex: i, statId: first.value[1] });
    }
  }
  return bindings;
}
