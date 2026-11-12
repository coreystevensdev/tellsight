import { z } from 'zod';

import type { StatType } from '../../apps/api/src/services/curation/types.js';
import { completenessJudge, faithfulnessJudge, insightJudge } from './judge-prompts.js';
import { askJudge, type GenerateProvider } from './parse-judge.js';

// These anchors isolate the exact facts rendered into each prompt without
// duplicating assembly's stat formatting in the evaluation harness.
const SUMMARIES_START = "computed from the business's uploaded data:\n\n";
const SUMMARIES_END = '\n\n**Data lineage:**';
export const AGENT_SUMMARIES_START = "that id is what belongs in a proposal's evidence array.\n\n";
const TODAY_LINE = /^Today is .+$/m;

const faithfulnessSchema = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      label: z.enum(['supported', 'derived', 'unsupported']),
      reason: z.string().optional(),
    }),
  ),
});

const completenessSchema = z.object({
  items: z.array(
    z.object({
      statType: z.string(),
      addressed: z.boolean(),
      evidence: z.string().optional(),
    }),
  ),
});

const insightSchema = z.object({
  insights: z.array(
    z.object({
      insight: z.string(),
      nonObvious: z.boolean(),
      actionable: z.boolean(),
      reason: z.string(),
    }),
  ),
});

export interface SampleScore {
  // What this sample cost, generation plus both judge calls. Recorded because
  // the cost cap refuses the most expensive samples and cost tracks output
  // length, so the exclusion is correlated with what the eval measures. Pairing
  // the two is what makes that correlation checkable instead of asserted
  // (DW-251).
  costUsd: number;
  faithfulness: number;
  // DW-244: the claims the judge deducted for. Carried rather than printed and
  // dropped, because the score says a sample was bad and only these say why,
  // and a run's console output does not outlive the run.
  unsupported: { claim: string; reason?: string }[];
  completeness: number;
  legalPass: boolean;
  legalViolations: string[];
  insightPass: boolean;
  qualifyingInsight: string | null;
  insightShortfall: string[];
  plainPass: boolean;
  plainViolations: string[];
  // Reported, never gated. See plain-language.ts for why the gloss half of
  // prompt rule 9 is measured rather than enforced.
  unglossed: string[];
}

export interface FixtureScore {
  id: string;
  label: string;
  // Samples the cost cap refused, kept apart from `errored`: those are
  // plausibly independent of the score, and these are not.
  capRefused: number;
  capRefusedCostsUsd: number[];
  // One row per scored sample. A single structure rather than parallel arrays
  // because the first version recorded cost per sample and the scores only as a
  // mean, which left the cost/score correlation that DW-251 exists to expose
  // still uncomputable from a stored scorecard.
  sampleScores: { costUsd: number; faithfulness: number; completeness: number }[];
  // Same split as AgentFixtureScore, for the same reason and on the arm whose
  // floors decide the exit code. DW-250.
  unmeasured: number;
  errored: number;
  faithfulness: {
    mean: number;
    min: number;
    unsupported: { claim: string; reason?: string }[];
  };
  completeness: { mean: number; min: number };
  legalPosture: { pass: boolean; violations: string[] };
  // `pass` is the gate; `unglossed*` is a reported rate. Both carry the same
  // empty-array caveat as legalPosture: every() on no samples is true, which is
  // why `unmeasured` and `errored` are counted separately (DW-242).
  plainLanguage: {
    pass: boolean;
    violations: string[];
    unglossedSamples: number;
    unglossedTerms: string[];
  };
  insight: { misses: number; examples: string[]; missed: string[] };
  sampledCount: number;
}

export interface AgentSample {
  proposalCount: number;
  faithfulness: number | null;
  completeness: number | null;
  legalPass: boolean;
  legalViolations: string[];
  plainPass: boolean;
  plainViolations: string[];
  unglossed: string[];
}

export interface AgentFixtureScore {
  id: string;
  label: string;
  // Shed samples never reached the API, so they are absent rather than bad.
  // Keeping them separate from a dropped sample is the whole of DW-242: an arm
  // that measured nothing printed the same PASS as an arm that measured
  // everything, because both ended with a short `samples` array.
  unmeasured: number;
  errored: number;
  faithfulness: { mean: number; min: number } | null;
  completeness: { mean: number; min: number } | null;
  legalPosture: { pass: boolean; violations: string[] };
  plainLanguage: {
    pass: boolean;
    violations: string[];
    unglossedSamples: number;
    unglossedTerms: string[];
  };
  proposalsPerSample: number;
  silentSamples: number;
  sampledCount: number;
}

export function extractGroundTruth(userPrompt: string, startAnchor = SUMMARIES_START): string {
  const start = userPrompt.indexOf(startAnchor);
  const end = userPrompt.indexOf(SUMMARIES_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'Could not find the statSummaries block in the assembled prompt. The template ' +
        `likely changed; update the summary-scoring anchors (looked for ${JSON.stringify(startAnchor)}).`,
    );
  }

  const stats = userPrompt.slice(start + startAnchor.length, end).trim();
  const today = TODAY_LINE.exec(userPrompt)?.[0];
  return today ? `${today}\n\n${stats}` : stats;
}

export interface FaithfulnessResult {
  score: number;
  // The judge's own words for what it rejected. A bare ratio says a quarter of
  // the claims failed and nothing about which quarter, so diagnosing a fixture
  // meant paying for the whole run again.
  unsupported: { claim: string; reason?: string }[];
}

export async function scoreFaithfulness(
  provider: GenerateProvider,
  groundTruth: string,
  summary: string,
): Promise<FaithfulnessResult> {
  const { claims } = await askJudge(
    provider,
    faithfulnessJudge(groundTruth, summary),
    faithfulnessSchema,
    'faithfulness',
  );
  if (claims.length === 0) return { score: 1, unsupported: [] };
  const bad = claims.filter((claim) => claim.label === 'unsupported');
  return {
    score: (claims.length - bad.length) / claims.length,
    unsupported: bad.map(({ claim, reason }) => ({ claim, reason })),
  };
}

export async function scoreCompleteness(
  provider: GenerateProvider,
  answerKey: StatType[],
  summary: string,
): Promise<number> {
  const { items } = await askJudge(
    provider,
    completenessJudge(answerKey, summary),
    completenessSchema,
    'completeness',
  );

  // Echo drift must remain visible: otherwise a judge returning "Cash Flow"
  // instead of "cash_flow" looks like a real completeness regression.
  const keySet = new Set<string>(answerKey);
  const returned = new Set(items.map((item) => item.statType));
  const unknown = [...returned].filter((statType) => !keySet.has(statType));
  const missing = answerKey.filter((statType) => !returned.has(statType));
  if (unknown.length > 0) {
    console.error(
      `  completeness judge returned unrecognized statTypes (echo drift?): ${unknown.join(', ')}`,
    );
  }
  if (missing.length > 0) {
    console.error(`  completeness judge omitted answer-key items: ${missing.join(', ')}`);
  }

  const addressed = new Set(items.filter((item) => item.addressed).map((item) => item.statType));
  return answerKey.filter((statType) => addressed.has(statType)).length / answerKey.length;
}

export async function scoreActionability(
  provider: GenerateProvider,
  summary: string,
): Promise<{ pass: boolean; qualifying: string | null; shortfall: string[] }> {
  const { insights } = await askJudge(provider, insightJudge(summary), insightSchema, 'insight');
  const qualifying = insights.find((insight) => insight.nonObvious && insight.actionable);
  if (qualifying) return { pass: true, qualifying: qualifying.insight, shortfall: [] };

  // Keep the failed candidates in the scorecard; successful examples do not
  // explain why another sample missed FR22.
  return {
    pass: false,
    qualifying: null,
    shortfall: insights.map(
      (insight) =>
        `[${insight.nonObvious ? 'non-obvious' : 'OBVIOUS'}/${insight.actionable ? 'actionable' : 'NOT actionable'}] ${insight.insight} -- ${insight.reason}`,
    ),
  };
}

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeFixtureSamples(
  fixture: { id: string; label: string },
  samples: SampleScore[],
  counts: {
    unmeasured: number;
    errored: number;
    capRefused?: number;
    capRefusedCostsUsd?: number[];
  } = { unmeasured: 0, errored: 0 },
): FixtureScore {
  const faithfulness = samples.map((sample) => sample.faithfulness);
  const completeness = samples.map((sample) => sample.completeness);
  return {
    id: fixture.id,
    label: fixture.label,
    unmeasured: counts.unmeasured,
    errored: counts.errored,
    capRefused: counts.capRefused ?? 0,
    capRefusedCostsUsd: counts.capRefusedCostsUsd ?? [],
    sampleScores: samples.map((sample) => ({
      costUsd: sample.costUsd,
      faithfulness: sample.faithfulness,
      completeness: sample.completeness,
    })),
    faithfulness: {
      mean: mean(faithfulness),
      min: Math.min(...faithfulness),
      // Deduped on the claim, the way insight.examples dedupes its strings. A
      // Set is no use on objects, and Map keeps the last value for a repeated
      // key, so where samples gave different reasons for the same claim the
      // latest sample's reason is the one kept. Any of them is representative
      // and the order is deterministic, which is the property that matters.
      unsupported: [
        ...new Map(
          samples
            .flatMap((sample) => sample.unsupported)
            .map((entry) => [entry.claim, entry] as const),
        ).values(),
      ],
    },
    completeness: { mean: mean(completeness), min: Math.min(...completeness) },
    legalPosture: {
      pass: samples.every((sample) => sample.legalPass),
      violations: [...new Set(samples.flatMap((sample) => sample.legalViolations))],
    },
    plainLanguage: {
      pass: samples.every((sample) => sample.plainPass),
      violations: [...new Set(samples.flatMap((sample) => sample.plainViolations))],
      unglossedSamples: samples.filter((sample) => sample.unglossed.length > 0).length,
      unglossedTerms: [...new Set(samples.flatMap((sample) => sample.unglossed))],
    },
    insight: {
      misses: samples.filter((sample) => !sample.insightPass).length,
      examples: [
        ...new Set(
          samples
            .map((sample) => sample.qualifyingInsight)
            .filter((insight): insight is string => insight !== null),
        ),
      ],
      missed: samples
        .filter((sample) => !sample.insightPass)
        .flatMap((sample) => sample.insightShortfall),
    },
    sampledCount: samples.length,
  };
}

export function summarizeAgentSamples(
  fixture: { id: string; label: string },
  samples: AgentSample[],
  counts: { unmeasured: number; errored: number } = { unmeasured: 0, errored: 0 },
): AgentFixtureScore {
  // Silence is a legitimate agent result, not zero-quality prose. Only samples
  // that emitted a proposal contribute to the prose metrics.
  const scoredSamples = samples.filter((sample) => sample.faithfulness !== null);
  const faithfulness = scoredSamples.map((sample) => sample.faithfulness as number);
  const completeness = scoredSamples.map((sample) => sample.completeness as number);
  return {
    id: fixture.id,
    label: fixture.label,
    unmeasured: counts.unmeasured,
    errored: counts.errored,
    faithfulness: faithfulness.length
      ? { mean: mean(faithfulness), min: Math.min(...faithfulness) }
      : null,
    completeness: completeness.length
      ? { mean: mean(completeness), min: Math.min(...completeness) }
      : null,
    legalPosture: {
      pass: samples.every((sample) => sample.legalPass),
      violations: [...new Set(samples.flatMap((sample) => sample.legalViolations))],
    },
    plainLanguage: {
      pass: samples.every((sample) => sample.plainPass),
      violations: [...new Set(samples.flatMap((sample) => sample.plainViolations))],
      unglossedSamples: samples.filter((sample) => sample.unglossed.length > 0).length,
      unglossedTerms: [...new Set(samples.flatMap((sample) => sample.unglossed))],
    },
    proposalsPerSample: mean(samples.map((sample) => sample.proposalCount)),
    silentSamples: samples.filter((sample) => sample.proposalCount === 0).length,
    sampledCount: samples.length,
  };
}
