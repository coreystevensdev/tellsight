// The measurable half of "No jargon" from the live prompt template:
//   apps/api/src/services/curation/config/prompt-templates/v2.3-system.md
//     line 70 -> "Write like a person, not a report. Short sentences. Vary their
//                 length. Have opinions. No jargon. If you must use a financial
//                 term, explain it in parentheses."
//     line 1  -> the reader is "a small business owner who doesn't have a
//                 finance background"
//
// Pure string scan, no model call, same contract as legal-posture.ts.
//
// The list below is every candidate term that the v2.3 templates never use
// themselves. That derivation matters more than the list: runway, burn rate,
// margin, break-even, fixed costs, structural, aggregate and top-line all appear
// in the prompt, so banning them would have the eval penalising the vocabulary
// production asks for. Measured on three samples before this existed, the model
// used runway, burn, margin, break-even and fixed costs and nothing outside the
// prompt's own vocabulary, which is why this gate passes today and is still worth
// having: it catches drift into accountant register, not the house style.
//
// If v2.3 is superseded, re-derive against the new template rather than copying
// this list forward. legal-posture.ts has the same warning for the same reason.
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

// Terms the prompt does use, and which rule 9 says to explain in parentheses on
// use. Reported, never gated: the prompt's bar is stricter than its own
// vocabulary, and three samples glossed none of them while reading perfectly
// plainly ("about 2.4 months", "roughly double where you are now"). Gating this
// would fail every healthy run, which is the mistake FR22's per-sample floor made
// before it became a pooled ceiling.
const NEEDS_GLOSS = ['runway', 'burn rate', 'margin', 'break-even', 'EBITDA'];

export interface PlainLanguageResult {
  /** False only when a term outside the prompt's own vocabulary appears. */
  pass: boolean;
  violations: string[];
  /** Reported, not gated. Terms rule 9 asks to gloss that were used bare. */
  unglossed: string[];
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

  const unglossed = NEEDS_GLOSS.filter(
    (t) => new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(summary) && !isGlossed(summary, t),
  );

  return { pass: violations.length === 0, violations, unglossed };
}
