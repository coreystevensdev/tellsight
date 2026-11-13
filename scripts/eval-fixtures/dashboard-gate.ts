// The dashboard arm's floors, extracted for the same reason agent-gate.ts was
// (DW-242): inline, they had no tests, and replacing a breach condition with
// `if (false)` left the whole suite green. DW-258. The comment in
// eval-summaries.ts said as much and named these as the ones still inline
// "because they predate the entry".

interface FixtureScore {
  id: string;
  faithfulness: { mean: number };
  completeness: { mean: number };
  legalPosture: { pass: boolean; violations: string[] };
  plainLanguage: { pass: boolean; violations: string[] };
  unmeasured: number;
  errored: number;
  sampledCount: number;
}

interface Floors {
  faithfulness: number;
  completeness: number;
}

export function dashboardGate(
  scored: readonly FixtureScore[],
  samples: number,
  floors: Floors,
): string[] {
  const breaches: string[] = [];

  for (const r of scored) {
    // DW-250: shedding is correlated, so the survivors are whatever ran before
    // the breaker tripped rather than a random subset. A mean over those is not
    // a noisier measurement of the same thing, so it is not graded at all.
    if (r.unmeasured > 0) {
      breaches.push(
        `${r.id}: inconclusive, ${r.unmeasured} of ${samples} samples shed before reaching the API ` +
          `(scored ${r.sampledCount}, errored ${r.errored})`,
      );
      continue;
    }
    if (r.faithfulness.mean < floors.faithfulness) {
      breaches.push(
        `${r.id}: faithfulness ${r.faithfulness.mean.toFixed(2)} < ${floors.faithfulness}`,
      );
    }
    if (r.completeness.mean < floors.completeness) {
      breaches.push(
        `${r.id}: completeness ${r.completeness.mean.toFixed(2)} < ${floors.completeness}`,
      );
    }
    if (!r.legalPosture.pass) {
      breaches.push(`${r.id}: legal posture failed (${r.legalPosture.violations.join('; ')})`);
    }
    if (!r.plainLanguage.pass) {
      breaches.push(`${r.id}: plain language failed (${r.plainLanguage.violations.join('; ')})`);
    }
  }

  return breaches;
}
