// Deterministic half of the lookup-vs-interpretation scorer. The LLM judge
// (judge-prompts.ts's interpretationJudge) can be talked into calling verbose,
// figure-free padding "interpretive"; this is the anti-padding backstop that
// forces such answers back to "lookup" regardless of what the judge says.
//
// Stat IDs like "3:trend:Sales:0" contain digits that aren't part of the
// answer's prose, so cite tags are stripped before the digit scan. When
// knownFigures is given, a digit figure that only restates one of them no
// longer counts, since restating a figure the question already supplied
// isn't interpretation.

import { stripAllCiteTags } from '../../packages/shared/src/constants/index.js';

const DIGIT_FIGURE = /-?\$?\d[\d,]*\.?\d*%?/g;

// Fractions and magnitudes only, not bare "double"/"triple"/"quadruple" --
// those are past-tense-or-nothing figure words ("revenue doubled") in this
// domain's answers, but the bare forms collide with idioms like
// "double-check" that carry no figure at all. "quarter" is left out because
// answers constantly say "this quarter"/"last quarter" as a calendar period,
// not a fraction, and spelled cardinals one-twenty are left out because
// they're too common as generic pronouns/determiners ("one of your top
// expenses") to be a reliable figure signal.
const SPELLED_FIGURE =
  /\b(half|third|fifth|sixth|seventh|eighth|ninth|tenth|doubled|tripled|quadrupled|dozen|hundred|thousand|million|billion)\b/i;

// Numeric value, not string, so "18%" and "18.0%" (or "$9,200" restated as
// "9200") compare equal regardless of formatting.
function figureValue(figure: string): number {
  return Number(figure.replace(/[^\d.-]/g, ''));
}

export function hasNumericFigure(answer: string, knownFigures: string[] = []): boolean {
  const stripped = stripAllCiteTags(answer);

  if (SPELLED_FIGURE.test(stripped)) return true;

  const extracted = stripped.match(DIGIT_FIGURE) ?? [];
  if (knownFigures.length === 0) return extracted.length > 0;

  const known = new Set(knownFigures.map(figureValue));
  return extracted.some((figure) => !known.has(figureValue(figure)));
}
