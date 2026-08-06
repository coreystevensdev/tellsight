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

const DIRECTIVE_SOURCE = `\\b(?:${BANNED_IMPERATIVES.map((p) => escapeRegExp(p).replace(/ /g, '\\s+')).join('|')})\\b`;

export function hasDirectiveLanguage(text: string): boolean {
  return new RegExp(DIRECTIVE_SOURCE, 'i').test(text);
}

// Every distinct matched phrase, for logging which one actually tripped.
export function findDirectiveLanguage(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(DIRECTIVE_SOURCE, 'gi'))].map((m) => m[0]))];
}
