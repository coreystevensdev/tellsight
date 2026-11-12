import type { ComputedStat, StatType } from '../../apps/api/src/services/curation/types.js';

// The threshold is lifted from the live agent prompt, not chosen here:
//   apps/api/src/services/curation/config/prompt-templates/v1-agent-system.md
//     "A worthwhile proposal does at least one of these: ... Flags a material
//      risk with a short action window (runway under 4 months, a single
//      category representing more than 70% of revenue)."
//
// Only the runway half is implemented. The prompt's other named trigger is a
// category over 70% "of revenue", and CategoryBreakdownDetails.percentage has no
// scope field saying what its denominator is, so a breakdown computed over
// expenses would have the trigger comparing against the wrong total. No fixture
// carries a category_breakdown stat today either. Adding it needs the denominator
// confirmed first; a threshold against an unknown total mismeasures silently,
// which is worse than being visibly absent.
//
// The prompt's remaining two bullets (connecting stats into a pattern, revealing
// a structural dynamic inside an aggregate) are judgment calls and belong to the
// faithfulness judge. This file is the deterministic half only.
//
// If the agent prompt is revised, re-derive from it rather than carrying this
// forward. legal-posture.ts and plain-language.ts carry the same warning.
const RUNWAY_MONTHS_FLOOR = 4;

export interface MaterialRisk {
  statType: StatType;
  /** Reads into a failure message, so it names the number that tripped. */
  because: string;
}

export function warrantedRisks(stats: ComputedStat[]): MaterialRisk[] {
  const risks: MaterialRisk[] = [];
  for (const stat of stats) {
    if (stat.statType !== 'runway') continue;
    const { runwayMonths } = stat.details;
    if (runwayMonths < RUNWAY_MONTHS_FLOOR) {
      risks.push({
        statType: 'runway',
        because: `runway is ${runwayMonths} months, under the ${RUNWAY_MONTHS_FLOOR} the prompt calls a short action window`,
      });
    }
  }
  return risks;
}

/** The statType segment of a `datasetId:statType:category:discriminator` id.
 *  expire.ts's re-validation sweep parses the same id the same way (DW-64). */
function citedStatType(evidenceId: string): string | null {
  return evidenceId.split(':')[1] ?? null;
}

export interface RiskCoverage {
  /** null when the fixture warrants no material risk. Nothing to find is not
   *  the same as found everything, and scoring a 1 for it would credit an arm
   *  for the fixture being calm rather than for its own work (DW-242's shape). */
  score: number | null;
  covered: StatType[];
  missed: MaterialRisk[];
}

/** Matched on the cited stat ids rather than the prose, because evidence is the
 *  one field the prompt requires to be copied literally from what the model was
 *  shown. A proposal can name runway in its title while citing something else;
 *  the citation is what ties it to the stat. */
export function scoreRiskCoverage(
  risks: MaterialRisk[],
  proposals: { evidence: string[] }[],
): RiskCoverage {
  if (risks.length === 0) return { score: null, covered: [], missed: [] };

  const cited = new Set(
    proposals.flatMap((p) => p.evidence.map(citedStatType).filter((t): t is string => t !== null)),
  );
  const covered = risks.filter((r) => cited.has(r.statType)).map((r) => r.statType);

  // An empty `proposals` lands here with score 0, which is the point. The prompt
  // sanctions calling the tool zero times "if nothing is worth flagging", and a
  // warranted risk means something is. Scoring silence as unmeasured is what let
  // 17 of 36 samples stay quiet about a 2.4-month runway without moving a number.
  return {
    score: covered.length / risks.length,
    covered,
    missed: risks.filter((r) => !cited.has(r.statType)),
  };
}
