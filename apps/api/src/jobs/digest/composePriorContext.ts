import type { ComputedStat } from '../../services/curation/types.js';
import type { PriorContextEntry } from './buildPriorContext.js';
import type { DigestMilestoneEntry } from './milestones.js';

// Composes the `{{priorContext}}` section for v2-digest.md. Pure: no I/O.
// Composition ownership: a fired milestone already narrates its crossing, so
// buildPriorContext's `delta` entry for the same statType is suppressed to
// avoid saying the same thing twice. `first_tracked` entries are never
// suppressed, a milestone can't fire on a stat that wasn't present last week.
// Returns '' when nothing survives, even if lastStateSentence is defined,
// since that empty string is what perOrg.ts uses to pick v1-digest over v2.
export function composePriorContext(
  lastStateSentence: string | undefined,
  deltaEntries: readonly PriorContextEntry[],
  milestones: readonly DigestMilestoneEntry[],
  weeksSincePrior = 1,
): string {
  const milestoneStatTypes = new Set(
    milestones.map((m) => m.statType).filter((statType): statType is ComputedStat['statType'] => statType !== null),
  );
  const survivingDeltas = deltaEntries.filter(
    (entry) => entry.kind === 'first_tracked' || !milestoneStatTypes.has(entry.statType),
  );

  if (survivingDeltas.length === 0 && milestones.length === 0) return '';

  const lines: string[] = [];
  if (lastStateSentence) {
    // The prior digest is whatever came last, not necessarily seven days ago.
    // Weeks get skipped when nothing was computable, so saying "last week" over
    // a gap would be a claim we cannot back.
    const lead = weeksSincePrior <= 1 ? 'Last week' : `${weeksSincePrior} weeks ago`;
    lines.push(`${lead}: ${lastStateSentence}`);
  }
  lines.push(...milestones.map((m) => m.label));
  lines.push(...survivingDeltas.map((entry) => entry.text));

  return lines.join('\n');
}
