import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_SUMMARIES_START,
  extractGroundTruth,
  scoreActionability,
  scoreCompleteness,
  scoreFaithfulness,
  summarizeAgentSamples,
  summarizeFixtureSamples,
  type AgentSample,
  type SampleScore,
} from './summary-scoring.js';

function providerReply(reply: unknown) {
  return {
    generate: vi.fn().mockResolvedValue(JSON.stringify(reply)),
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractGroundTruth', () => {
  it('keeps the evaluation date with the rendered stats', () => {
    const prompt = [
      'Today is January 15, 2026.',
      "computed from the business's uploaded data:\n\nRevenue fell 12%.",
      '**Data lineage:**',
      'uploads only',
    ].join('\n\n');

    expect(extractGroundTruth(prompt)).toBe('Today is January 15, 2026.\n\nRevenue fell 12%.');
  });

  it('supports the agent prompt anchor', () => {
    const prompt = `${AGENT_SUMMARIES_START}Cash covers 2.4 months.\n\n**Data lineage:** uploads only`;
    expect(extractGroundTruth(prompt, AGENT_SUMMARIES_START)).toBe('Cash covers 2.4 months.');
  });

  it('fails loudly when prompt structure changes', () => {
    expect(() => extractGroundTruth('an unrelated prompt')).toThrow(
      /Could not find the statSummaries block/,
    );
  });
});

describe('judge scoring', () => {
  it('counts supported and derived claims as faithful', async () => {
    const provider = providerReply({
      claims: [
        { claim: 'a', label: 'supported' },
        { claim: 'b', label: 'derived' },
        { claim: 'c', label: 'unsupported' },
      ],
    });
    const result = await scoreFaithfulness(provider, 'facts', 'summary');
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.unsupported).toEqual([{ claim: 'c', reason: undefined }]);
  });

  it('scores completeness against the answer key rather than extra judge items', async () => {
    const provider = providerReply({
      items: [
        { statType: 'cash_flow', addressed: true },
        { statType: 'runway', addressed: false },
        { statType: 'invented', addressed: true },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(scoreCompleteness(provider, ['cash_flow', 'runway'], 'summary')).resolves.toBe(
      0.5,
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invented'));
  });

  it('requires one insight to be both non-obvious and actionable', async () => {
    const provider = providerReply({
      insights: [
        {
          insight: 'obvious action',
          nonObvious: false,
          actionable: true,
          reason: 'already stated',
        },
        {
          insight: 'novel observation',
          nonObvious: true,
          actionable: false,
          reason: 'no next step',
        },
      ],
    });

    await expect(scoreActionability(provider, 'summary')).resolves.toMatchObject({
      pass: false,
      qualifying: null,
      shortfall: [
        expect.stringContaining('OBVIOUS/actionable'),
        expect.stringContaining('non-obvious/NOT actionable'),
      ],
    });
  });
});

describe('sample summaries', () => {
  it('keeps a cost-cap refusal apart from an error, with what it cost', () => {
    // A shed or errored sample is plausibly independent of the score. A cap
    // refusal is not: the cap refuses the priciest calls and cost tracks output
    // length, so these are the longest summaries being dropped. Bucketing them
    // as errors would hide that. DW-251.
    const sample: SampleScore = {
      costUsd: 0.005,
      faithfulness: 1,
      unsupported: [],
      completeness: 1,
      legalPass: true,
      legalViolations: [],
      insightPass: true,
      qualifyingInsight: 'x',
      insightShortfall: [],
    };
    const score = summarizeFixtureSamples({ id: 'cash', label: 'Cash' }, [sample], {
      unmeasured: 0,
      errored: 1,
      capRefused: 2,
      capRefusedCostsUsd: [0.0168, 0.0159],
    });

    expect(score.capRefused).toBe(2);
    expect(score.capRefusedCostsUsd).toEqual([0.0168, 0.0159]);
    expect(score.errored).toBe(1);
    // Both refusals cost more than the one sample that survived, which is the
    // comparison the run prints and the reason the exclusion is not neutral.
    expect(Math.min(...score.capRefusedCostsUsd)).toBeGreaterThan(
      Math.max(...score.sampleScores.map((x) => x.costUsd)),
    );
  });

  it('pairs each scored sample with what it cost', () => {
    const mk = (costUsd: number, faithfulness: number): SampleScore => ({
      costUsd,
      faithfulness,
      unsupported: [],
      completeness: 1,
      legalPass: true,
      legalViolations: [],
      insightPass: true,
      qualifyingInsight: 'x',
      insightShortfall: [],
    });
    const score = summarizeFixtureSamples({ id: 'cash', label: 'Cash' }, [
      mk(0.004, 1),
      mk(0.011, 0.75),
    ]);

    // Index-aligned with the samples, so a stored scorecard is enough to check
    // whether cost tracks score without re-running the eval.
    // Cost and score in the same row, which is what makes the correlation
    // computable from a stored scorecard instead of needing another paid run.
    expect(score.sampleScores).toEqual([
      { costUsd: 0.004, faithfulness: 1, completeness: 1 },
      { costUsd: 0.011, faithfulness: 0.75, completeness: 1 },
    ]);
    expect(score.sampleScores).toHaveLength(score.sampledCount);
  });

  it('carries the shed and errored counts onto the score', () => {
    // The gate reads these off FixtureScore, so a count that does not propagate
    // leaves the arm ungated exactly as it was before DW-250.
    const sample: SampleScore = {
      costUsd: 0.005,
      faithfulness: 1,
      unsupported: [],
      completeness: 1,
      legalPass: true,
      legalViolations: [],
      insightPass: true,
      qualifyingInsight: 'x',
      insightShortfall: [],
    };
    const score = summarizeFixtureSamples({ id: 'cash', label: 'Cash' }, [sample], {
      unmeasured: 7,
      errored: 2,
    });

    expect(score.unmeasured).toBe(7);
    expect(score.errored).toBe(2);
    expect(score.sampledCount).toBe(1);
  });

  it('aggregates fixture scores and deduplicates diagnostic text', () => {
    const samples: SampleScore[] = [
      {
        costUsd: 0.004,
        faithfulness: 1,
        unsupported: [{ claim: 'a ceiling is coming', reason: 'speculative' }],
        completeness: 0.5,
        legalPass: true,
        legalViolations: [],
        insightPass: true,
        qualifyingInsight: 'compare the two periods',
        insightShortfall: [],
      },
      {
        costUsd: 0.009,
        faithfulness: 0.5,
        // The repeated claim carries a different reason, which is the case a
        // Set cannot collapse: dedupe is keyed on the claim, and Map keeps the
        // last value, so this sample's reason is the one that survives.
        unsupported: [
          { claim: 'a ceiling is coming', reason: 'not derivable' },
          { claim: 'growth came from existing capacity' },
        ],
        completeness: 1,
        legalPass: false,
        legalViolations: ['imperative', 'imperative'],
        insightPass: false,
        qualifyingInsight: null,
        insightShortfall: ['missing action'],
      },
    ];

    expect(summarizeFixtureSamples({ id: 'cash', label: 'Cash' }, samples)).toEqual({
      id: 'cash',
      label: 'Cash',
      unmeasured: 0,
      errored: 0,
      capRefused: 0,
      capRefusedCostsUsd: [],
      sampleScores: [
        { costUsd: 0.004, faithfulness: 1, completeness: 0.5 },
        { costUsd: 0.009, faithfulness: 0.5, completeness: 1 },
      ],
      faithfulness: {
        mean: 0.75,
        min: 0.5,
        unsupported: [
          { claim: 'a ceiling is coming', reason: 'not derivable' },
          { claim: 'growth came from existing capacity' },
        ],
      },
      completeness: { mean: 0.75, min: 0.5 },
      legalPosture: { pass: false, violations: ['imperative'] },
      insight: { misses: 1, examples: ['compare the two periods'], missed: ['missing action'] },
      sampledCount: 2,
    });
  });

  it('reports all-silent agent runs as unscored prose', () => {
    const samples: AgentSample[] = [
      {
        proposalCount: 0,
        faithfulness: null,
        completeness: null,
        legalPass: true,
        legalViolations: [],
      },
      {
        proposalCount: 0,
        faithfulness: null,
        completeness: null,
        legalPass: true,
        legalViolations: [],
      },
    ];

    expect(summarizeAgentSamples({ id: 'steady', label: 'Steady' }, samples)).toMatchObject({
      faithfulness: null,
      completeness: null,
      proposalsPerSample: 0,
      silentSamples: 2,
      sampledCount: 2,
    });
  });
});
