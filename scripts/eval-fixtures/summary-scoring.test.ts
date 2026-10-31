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
    await expect(scoreFaithfulness(provider, 'facts', 'summary')).resolves.toBeCloseTo(2 / 3);
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
  it('aggregates fixture scores and deduplicates diagnostic text', () => {
    const samples: SampleScore[] = [
      {
        faithfulness: 1,
        completeness: 0.5,
        legalPass: true,
        legalViolations: [],
        insightPass: true,
        qualifyingInsight: 'compare the two periods',
        insightShortfall: [],
      },
      {
        faithfulness: 0.5,
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
      faithfulness: { mean: 0.75, min: 0.5 },
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
