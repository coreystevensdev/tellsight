// Deterministic half of the lookup-vs-interpretation scorer. The LLM judge
// (judge-prompts.ts's interpretationJudge) can be talked into calling verbose,
// figure-free padding "interpretive"; this is the anti-padding backstop that
// forces such answers back to "lookup" regardless of what the judge says.
//
// Stat IDs like "3:trend:Sales:0" contain digits that aren't part of the
// answer's prose, so cite tags are stripped before the digit scan.

import { stripAllCiteTags } from '../../packages/shared/src/constants/index.js';

export function hasNumericFigure(answer: string): boolean {
  return /\d/.test(stripAllCiteTags(answer));
}
