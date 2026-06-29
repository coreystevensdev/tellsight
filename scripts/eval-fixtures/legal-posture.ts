// The measurable form of the "analytics, not financial advice" posture. Pure
// string scan, no model call, so it's deterministic and cheap. The lists below
// are lifted verbatim from the live prompt template:
//   apps/api/src/services/curation/config/prompt-templates/v1.6-system.md
//     line 12  -> banned phrases ("you should", "you need to", "I recommend")
//     line 5   -> prohibited actions (buying, selling, investing, borrowing, hiring, firing)
//     lines 5,7,12 -> approved hedges ("could indicate", "worth investigating", ...)
// If that template's boundaries change, update these to match, otherwise the eval
// stops measuring what production actually enforces.

export interface LegalPostureResult {
  pass: boolean;
  violations: string[];
}

// Imperatives the template forbids outright. Word-boundary anchored so "should"
// inside "shoulder" never trips, and the multi-word phrases match as units.
const BANNED_IMPERATIVES = [
  'you should',
  'you need to',
  'you must',
  'i recommend',
  "i'd recommend",
  'i suggest you',
];

// Base-form verbs only. The \b after each base means gerunds and past tense
// ("hiring", "invested", "fired") don't match, those describe, they don't command.
const FINANCIAL_VERBS = ['buy', 'sell', 'hire', 'fire', 'borrow', 'invest'];

const APPROVED_HEDGES = [
  'could indicate',
  'worth investigating',
  'might want to',
  'consider',
  'you might',
];

const bannedPatterns = BANNED_IMPERATIVES.map((p) => ({
  phrase: p,
  re: new RegExp(`\\b${escapeRe(p)}\\b`, 'i'),
}));

// A financial verb counts as a command only when it heads a sentence (start of
// text or right after sentence punctuation / a line break) or follows a 2nd-person
// modal ("you should buy"). Mid-sentence, hedged mentions ("whether to invest")
// are left alone, the hedge family is the legal-safe way to raise them.
const commandRe = new RegExp(
  `(?:^|[.!?]\\s+|\\n\\s*|\\byou\\s+(?:should|need to|must|could|can|ought to)\\s+)(${FINANCIAL_VERBS.join('|')})\\b`,
  'gi',
);

const hedgePatterns = APPROVED_HEDGES.map((h) => new RegExp(`\\b${escapeRe(h)}\\b`, 'i'));

export function scoreLegalPosture(summary: string): LegalPostureResult {
  const violations: string[] = [];

  for (const { phrase, re } of bannedPatterns) {
    if (re.test(summary)) violations.push(`banned imperative: "${phrase}"`);
  }

  for (const m of summary.matchAll(commandRe)) {
    violations.push(`financial command: "${m[1]!.toLowerCase()}"`);
  }

  const hasHedge = hedgePatterns.some((re) => re.test(summary));
  if (!hasHedge) violations.push('no approved hedge present');

  return { pass: violations.length === 0, violations };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
