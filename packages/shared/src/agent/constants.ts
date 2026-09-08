// Directive phrases the advisory-voice boundary forbids. "Analytics, not financial
// advice": a stray "you should" is the kind of imperative that would need RIA
// registration, so both checkpoints reject it, the runtime proposal validator
// (proposal.ts, at the API boundary) and the eval harness's legal-posture scorer
// (scripts/eval-fixtures/legal-posture.ts, at QA time). They used to keep separate
// copies and drifted (a regex bug nearly shipped a directive proposal). One list now,
// two consumers, so the runtime check and the QA check can't fall out of sync.
//
// Sourced from the live prompt template:
//   apps/api/src/services/curation/config/prompt-templates/v1.6-system.md:12
// If that template's banned language changes, change it here.
export const BANNED_IMPERATIVES = [
  'you should',
  'you need to',
  'you must',
  'you ought to',
  'i recommend',
  "i'd recommend",
  'i suggest you',
] as const;

// Metacharacters escaped first (today's BANNED_IMPERATIVES has none, but a
// future phrase might), then interior spaces become \s+ so "you   should" or
// a line break still trips it.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "you need to" is the one phrase here that also has a purely descriptive
// reading: "the gap between what you're earning and what you need to break even"
// states a number, it does not tell anyone to do anything. A substring match
// cannot separate those, and the eval harness flagged exactly that sentence as a
// banned imperative on a live generation.
//
// Flagging it is not harmless. This runs on every AI summary in production and
// fires an analytics event the admin compliance view reads, so a false positive
// there teaches an operator to discount the signal that matters.
//
// Narrow on purpose: only this phrase, only directly after a relative pronoun.
// "You need to cut costs" is untouched, and so is every other banned phrase.
const RELATIVE_READING: Partial<Record<(typeof BANNED_IMPERATIVES)[number], string>> = {
  'you need to': '(?<!\\b(?:what|whatever)\\s+)',
};

const DIRECTIVE_SOURCE = `\\b(?:${BANNED_IMPERATIVES.map(
  (p) => `${RELATIVE_READING[p] ?? ''}${escapeRegExp(p).replace(/ /g, '\\s+')}`,
).join('|')})\\b`;

export function hasDirectiveLanguage(text: string): boolean {
  return new RegExp(DIRECTIVE_SOURCE, 'i').test(text);
}

// Every distinct matched phrase, for logging which one actually tripped.
export function findDirectiveLanguage(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(DIRECTIVE_SOURCE, 'gi'))].map((m) => m[0]))];
}
