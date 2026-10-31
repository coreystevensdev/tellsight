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
  faithfulness: number;
  completeness: number;
  legalPass: boolean;
  legalViolations: string[];
  insightPass: boolean;
  qualifyingInsight: string | null;
  insightShortfall: string[];
}

export interface FixtureScore {
  id: string;
  label: string;
  faithfulness: { mean: number; min: number };
  completeness: { mean: number; min: number };
  legalPosture: { pass: boolean; violations: string[] };
  insight: { misses: number; examples: string[]; missed: string[] };
  sampledCount: number;
}

export interface AgentSample {
  proposalCount: number;
  faithfulness: number | null;
  completeness: number | null;
  legalPass: boolean;
  legalViolations: string[];
}

export interface AgentFixtureScore {
  id: string;
  label: string;
  faithfulness: { mean: number; min: number } | null;
  completeness: { mean: number; min: number } | null;
  legalPosture: { pass: boolean; violations: string[] };
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

export async function scoreFaithfulness(
  provider: GenerateProvider,
  groundTruth: string,
  summary: string,
): Promise<number> {
  const { claims } = await askJudge(
    provider,
    faithfulnessJudge(groundTruth, summary),
    faithfulnessSchema,
    'faithfulness',
  );
  if (claims.length === 0) return 1;
  return claims.filter((claim) => claim.label !== 'unsupported').length / claims.length;
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
): FixtureScore {
  const faithfulness = samples.map((sample) => sample.faithfulness);
  const completeness = samples.map((sample) => sample.completeness);
  return {
    id: fixture.id,
    label: fixture.label,
    faithfulness: { mean: mean(faithfulness), min: Math.min(...faithfulness) },
    completeness: { mean: mean(completeness), min: Math.min(...completeness) },
    legalPosture: {
      pass: samples.every((sample) => sample.legalPass),
      violations: [...new Set(samples.flatMap((sample) => sample.legalViolations))],
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
): AgentFixtureScore {
  // Silence is a legitimate agent result, not zero-quality prose. Only samples
  // that emitted a proposal contribute to the prose metrics.
  const scoredSamples = samples.filter((sample) => sample.faithfulness !== null);
  const faithfulness = scoredSamples.map((sample) => sample.faithfulness as number);
  const completeness = scoredSamples.map((sample) => sample.completeness as number);
  return {
    id: fixture.id,
    label: fixture.label,
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
    proposalsPerSample: mean(samples.map((sample) => sample.proposalCount)),
    silentSamples: samples.filter((sample) => sample.proposalCount === 0).length,
    sampledCount: samples.length,
  };
}
