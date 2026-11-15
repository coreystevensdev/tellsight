// The measurable half of rule 9 from the live prompt template:
//   apps/api/src/services/curation/config/prompt-templates/v2.4-system.md
//     line 70 -> "Margin, break-even and fixed costs are ordinary words for
//                 someone running a business, use them plainly. Runway and burn
//                 rate are borrowed from startups, so the first time you use
//                 either, say what it means in the same sentence."
//     line 1  -> the reader is "a small business owner who doesn't have a
//                 finance background"
//
// v2.3 said "No jargon. If you must use a financial term, explain it in
// parentheses", which no measured sample ever obeyed: three samples used runway,
// margin and break-even bare. The cause was not the rule. v2.3 used `runway` 29
// times and glossed it none, and one of the three samples reproduced its example
// clause verbatim, so the model was copying a demonstration that contradicted the
// instruction. v2.4 narrows the rule to the two terms genuinely borrowed from
// startup vocabulary and glosses them in its own examples.
//
// Pure string scan, no model call, same contract as legal-posture.ts.
//
// The list below is every candidate term that the v2.4 templates never use
// themselves. That derivation matters more than the list: runway, burn rate,
// margin, break-even, fixed costs, structural, aggregate and top-line all appear
// in the prompt, so banning them would have the eval penalising the vocabulary
// production asks for. Measured on three samples before this existed, the model
// used runway, burn, margin, break-even and fixed costs and nothing outside the
// prompt's own vocabulary, which is why this gate passes today and is still worth
// having: it catches drift into accountant register, not the house style.
//
// Re-derived against v2.4 when v2.3 was superseded, and unchanged: all 22 are
// still absent from both halves of the template. Re-derive again on the next
// version rather than copying this list forward, and also against
// v1-agent-*.md, which this gate scores too and which was never checked until
// the agent wrote "a near-term liquidity crisis" (DW-266).
//
// One trap in that re-derivation: "absent from the template" is the test, and a
// prompt can name a banned term as an example of what NOT to write. A grep then
// excludes exactly the term that should be banned. Both templates deliberately
// describe the category instead of listing instances, which keeps the grep sound
// and also avoids the model copying a negative example as content, which this
// repo has already measured happening. legal-posture.ts has the same warning for the same reason.
const OFF_VOCABULARY = [
  'EBITDA',
  'EBIT',
  'liquidity',
  'working capital',
  'variance',
  'CAGR',
  'YoY',
  'MoM',
  'QoQ',
  'amortization',
  'amortisation',
  'accrual',
  'accruals',
  'cost basis',
  'bottom-line',
  'headwind',
  'headwinds',
  'tailwind',
  'tailwinds',
  'opex',
  'capex',
  'ROI',
];

// Exactly the two terms v2.4's rule 9 names. margin, break-even and fixed costs
// came off this list when the rule blessed them as ordinary: measuring a bar the
// prompt no longer sets would report a failure nobody asked for.
//
// Still reported rather than gated, for one more run. v2.4 is the first version
// whose examples demonstrate the gloss, so whether the rule now holds is a
// measurement and not a prediction; gating it before that reading would be
// FR22's per-sample floor again, failing healthy runs on an untested threshold.
const NEEDS_GLOSS = ['runway', 'burn rate'];

export interface PlainLanguageResult {
  /** False only when a term outside the prompt's own vocabulary appears. */
  pass: boolean;
  violations: string[];
  /** Reported, not gated. Terms rule 9 asks to gloss that were used bare. */
  unglossed: string[];
  /** Terms rule 9 asks to gloss that were used and glossed. A term in neither
   *  list was never used, which is not the same as glossed: a prompt change
   *  that stops the model reaching for the word at all would otherwise read as
   *  a perfect gloss rate. */
  glossed: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentenceAround(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i === -1) return '';
  const start = Math.max(0, text.lastIndexOf('.', i) + 1);
  const end = text.indexOf('.', i);
  return text.slice(start, end === -1 ? undefined : end + 1).trim();
}

/** A term counts as glossed when a parenthetical follows it within the same
 *  sentence and contains prose rather than just a figure: "(the months of cash
 *  left at this spend rate)" glosses, "($24,000)" does not. Two words of four
 *  and three letters is the whole bar, and it is deliberately the only one: a
 *  minimum length here would shadow it, passing a test that reads as if it
 *  checked for prose while the length did the work. */
function isGlossed(summary: string, term: string): boolean {
  const re = new RegExp(`${escapeRe(term)}[^.()]{0,60}\\(([^)]+)\\)`, 'i');
  const m = re.exec(summary);
  if (!m) return false;
  return /[a-z]{4,}\s+[a-z]{3,}/i.test(m[1] ?? '');
}

export function scorePlainLanguage(summary: string): PlainLanguageResult {
  const violations: string[] = [];
  for (const term of OFF_VOCABULARY) {
    const re = new RegExp(`\\b${escapeRe(term)}\\b`, 'i');
    if (re.test(summary)) {
      violations.push(`off-vocabulary term: "${term}" in: ${sentenceAround(summary, term)}`);
    }
  }

  const used = NEEDS_GLOSS.filter((t) =>
    new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(summary),
  );

  return {
    pass: violations.length === 0,
    violations,
    unglossed: used.filter((t) => !isGlossed(summary, t)),
    glossed: used.filter((t) => isGlossed(summary, t)),
  };
}

/** The per-sample log line is the only copy that survives a run that throws, so
 *  it spells out all three states rather than just the bare terms. Grep it with
 *  `grep -c 'burn rate bare'`. */
export function formatGloss(r: PlainLanguageResult): string {
  const parts = [...r.glossed.map((t) => `${t} glossed`), ...r.unglossed.map((t) => `${t} bare`)];
  return parts.length > 0 ? parts.join(', ') : 'no terms used';
}
