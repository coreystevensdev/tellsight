import { describe, it, expect } from 'vitest';

import { agentGate } from './agent-gate.js';

const FLOORS = { faithfulness: 0.85, completeness: 0.8 };

function score(over: Partial<Parameters<typeof agentGate>[0][number]> = {}) {
  return {
    id: 'healthy-growth',
    faithfulness: { mean: 0.93 },
    completeness: { mean: 0.9 },
    legalPosture: { pass: true, violations: [] },
    unmeasured: 0,
    errored: 0,
    sampledCount: 10,
    ...over,
  };
}

describe('agentGate', () => {
  it('passes a clean arm', () => {
    const { breaches, ungraded } = agentGate([score()], [], 1, 10, FLOORS);
    expect(breaches).toEqual([]);
    expect(ungraded).toEqual([]);
  });

  // The three failures DW-242 recorded, each the actual observed one.
  it('fails the completeness the dashboard arm is held to', () => {
    // agent/cash-crunch scored 0.75 against a floor of 0.8 and the run printed
    // "all fixtures meet the floors".
    const { breaches } = agentGate(
      [score({ id: 'cash-crunch', completeness: { mean: 0.75 } })],
      [],
      1,
      10,
      FLOORS,
    );
    expect(breaches).toEqual(['agent/cash-crunch: completeness 0.75 < 0.8']);
  });

  it('fails a fixture that produced no result at all', () => {
    // seasonal-anomaly threw, so it left no entry. A floor over the scored
    // array cannot see it, which is why absence is checked separately.
    const { breaches } = agentGate([score()], ['seasonal-anomaly'], 2, 10, FLOORS);
    expect(breaches).toContain('agent/seasonal-anomaly: fixture produced no result at all');
  });

  it('fails when the fixtures do not add up, even with nothing else wrong', () => {
    // A fixture lost without landing in either array: the case where both the
    // floors and the failure list stay silent.
    const { breaches } = agentGate([score()], [], 3, 10, FLOORS);
    expect(breaches).toEqual([
      'agent arm: 1 scored + 0 failed does not account for 3 selected fixtures',
    ]);
  });

  it('reports a shed arm as inconclusive rather than grading its mean', () => {
    // 7 of 10 shed on the real run. The surviving 3 scored 0.93, which passes
    // every floor, so grading the mean reports a pass for an arm that mostly
    // never ran.
    const { breaches } = agentGate(
      [score({ id: 'seasonal-anomaly', unmeasured: 7, errored: 0, sampledCount: 3 })],
      [],
      1,
      10,
      FLOORS,
    );
    expect(breaches).toEqual([
      'agent/seasonal-anomaly: inconclusive, 7 of 10 samples shed before reaching the API (scored 3, errored 0)',
    ]);
  });

  it('does not grade an all-silent fixture against prose floors', () => {
    // Silence is what the prompt asks for when nothing is worth flagging, so a
    // null mean is an absent measurement, not a zero-quality one.
    const { breaches, ungraded } = agentGate(
      [score({ faithfulness: null, completeness: null })],
      [],
      1,
      10,
      FLOORS,
    );
    expect(breaches).toEqual([]);
    expect(ungraded).toEqual(['agent/healthy-growth: all 10 samples silent, no prose to grade']);
  });

  it('a shed sample outranks a low score, because the score is not a measurement', () => {
    const { breaches } = agentGate(
      [score({ unmeasured: 4, completeness: { mean: 0.1 } })],
      [],
      1,
      10,
      FLOORS,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toContain('inconclusive');
  });

  it('reports a legal-posture failure with its violations', () => {
    const { breaches } = agentGate(
      [score({ legalPosture: { pass: false, violations: ['you should refinance'] } })],
      [],
      1,
      10,
      FLOORS,
    );
    expect(breaches).toEqual([
      'agent/healthy-growth: legal posture failed (you should refinance)',
    ]);
  });
});
