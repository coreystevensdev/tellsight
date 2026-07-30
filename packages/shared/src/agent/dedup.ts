import type { FindingKind } from './proposal.js';

// A finding's identity, minus its exact value. Two runs that surface the same
// ongoing concern must produce the same key so the gate suppresses the repeat;
// a materially changed concern must produce a different key so it re-alerts.
export interface DedupInput {
  kind: FindingKind;
  subject: string; // stable identity of what the finding is about (category, stat root, target id)
  // A coarse bucket that SHOULD re-alert when it flips: put the severity tier or
  // the direction here, never the raw value, or every run reads as brand new.
  facet?: string;
}

// Strip the delimiter from the parts so a subject like "a:b" can't masquerade
// as a different (subject, facet) split. Hyphens fold in alongside whitespace
// since "cash-runway" and "cash runway" are the same word break to a model;
// the leading/trailing trim after that catches a stray colon (e.g. "runway:")
// from leaving a dangling underscore that would otherwise dodge the alias match below.
const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/:/g, '_')
    .replace(/^_+|_+$/g, '');

// Only the two subjects the agent system prompt names as examples ("runway",
// "margin") get synonym collapsing. Keyed by the post-norm() shape. Everything
// else is freeform CSV category text (e.g. "Marketing") where a fuzzy match
// would risk colliding genuinely distinct concerns.
// A Map, not an object literal -- subject is unvalidated model text, and a
// plain object's bracket lookup falls through to Object.prototype for keys
// like "__proto__" or "constructor", silently colliding unrelated subjects.
const SUBJECT_ALIASES = new Map([
  ['cash_runway', 'runway'],
  ['profit_margin', 'margin'],
  ['gross_margin', 'margin'],
]);

const normSubject = (s: string): string => {
  const key = norm(s);
  return SUBJECT_ALIASES.get(key) ?? key;
};

export function deriveDedupKey(input: DedupInput): string {
  return `${input.kind}:${normSubject(input.subject)}:${norm(input.facet ?? 'default')}`;
}
