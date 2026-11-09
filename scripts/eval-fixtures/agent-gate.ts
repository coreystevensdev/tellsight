// The agent arm ran, wrote its numbers into the scorecard, and was graded by
// nothing. A run printed "all fixtures meet the floors" while that arm had lost
// seasonal-anomaly entirely and scored cash-crunch's completeness at 0.75,
// below the 0.8 the dashboard arm is held to. DW-242.
//
// Floors alone would not have closed it. Two of the three failures here are
// about absence: a fixture that dies leaves no entry to apply a floor to, and a
// shed sample leaves no measurement to compare against one. A gate has to be
// able to say "I could not look" separately from "I looked and it was fine."

interface AgentScore {
  id: string;
  faithfulness: { mean: number } | null;
  completeness: { mean: number } | null;
  legalPosture: { pass: boolean; violations: string[] };
  unmeasured: number;
  errored: number;
  sampledCount: number;
}

interface Floors {
  faithfulness: number;
  completeness: number;
}

export interface AgentGateResult {
  breaches: string[];
  // Silence is a real agent answer rather than bad prose, so an all-silent
  // fixture is reported and not graded. Surfaced so the caller can print it.
  ungraded: string[];
}

export function agentGate(
  scored: AgentScore[],
  failedFixtureIds: string[],
  selectedCount: number,
  samples: number,
  floors: Floors,
): AgentGateResult {
  const breaches: string[] = [];
  const ungraded: string[] = [];

  for (const id of failedFixtureIds) {
    breaches.push(`agent/${id}: fixture produced no result at all`);
  }

  if (scored.length + failedFixtureIds.length !== selectedCount) {
    breaches.push(
      `agent arm: ${scored.length} scored + ${failedFixtureIds.length} failed does not account ` +
        `for ${selectedCount} selected fixtures`,
    );
  }

  for (const r of scored) {
    // Shedding is correlated, not random. Once the breaker opens every later
    // sample sheds, and samples run back to back so the 30s cooldown never
    // closes. What survives is whatever ran before the trip, which makes the
    // mean a measurement of a different thing rather than a smaller
    // measurement of the same one. Inconclusive, not passing.
    if (r.unmeasured > 0) {
      breaches.push(
        `agent/${r.id}: inconclusive, ${r.unmeasured} of ${samples} samples shed before reaching ` +
          `the API (scored ${r.sampledCount}, errored ${r.errored})`,
      );
      continue;
    }
    if (r.faithfulness === null || r.completeness === null) {
      ungraded.push(`agent/${r.id}: all ${r.sampledCount} samples silent, no prose to grade`);
      continue;
    }
    if (r.faithfulness.mean < floors.faithfulness) {
      breaches.push(
        `agent/${r.id}: faithfulness ${r.faithfulness.mean.toFixed(2)} < ${floors.faithfulness}`,
      );
    }
    if (r.completeness.mean < floors.completeness) {
      breaches.push(
        `agent/${r.id}: completeness ${r.completeness.mean.toFixed(2)} < ${floors.completeness}`,
      );
    }
    if (!r.legalPosture.pass) {
      breaches.push(`agent/${r.id}: legal posture failed (${r.legalPosture.violations.join('; ')})`);
    }
  }

  return { breaches, ungraded };
}
