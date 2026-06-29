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
// as a different (subject, facet) split.
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '_').replace(/:/g, '_');

export function deriveDedupKey(input: DedupInput): string {
  return `${input.kind}:${norm(input.subject)}:${norm(input.facet ?? 'default')}`;
}
