import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// interpretationTools.ts pulls in db/queries, which loads config.ts at import
// time and throws without a full set of env vars. qaAnswer only needs the two
// tool names, so stub the module the same way qaLoop.test.ts does.
vi.mock('./interpretationTools.js', () => ({
  GET_METRIC_WITH_TREND_TOOL: { name: 'get_metric_with_trend' },
  COMPARE_TO_PRIOR_PERIODS_TOOL: { name: 'compare_to_prior_periods' },
}));

import { logger } from '../../lib/logger.js';
import { AI_DISCLAIMER } from 'shared/constants';
import { assembleQaAnswer } from './qaAnswer.js';
import type { QaLoopResult, QaToolResult } from './qaLoop.js';

function loopResult(over: Partial<QaLoopResult> = {}): QaLoopResult {
  return {
    answer: 'Revenue is trending up.',
    toolResults: [],
    termination: 'answered',
    turnCount: 1,
    narration: [],
    ...over,
  };
}

function getMetricResult(id: string, output: unknown = { id, statType: 'trend', category: 'Sales', value: 12, details: {} }): QaToolResult {
  return { name: 'get_metric_with_trend', input: { statType: 'trend' }, output };
}

function compareResult(id: string, hasHistory = false): QaToolResult {
  return {
    name: 'compare_to_prior_periods',
    input: { statType: 'trend' },
    output: hasHistory
      ? { current: { id, statType: 'trend', category: 'Sales', value: 12, details: {} }, hasHistory: true, priorPeriods: [] }
      : { current: { id, statType: 'trend', category: 'Sales', value: 12, details: {} }, hasHistory: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assembleQaAnswer', () => {
  it('keeps a valid citation from get_metric_with_trend and lists its id', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite id="3:trend:Sales:0"/> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).toContain('<cite id="3:trend:Sales:0"/>');
    expect(result.citedStatIds).toEqual(['3:trend:Sales:0']);
  });

  it('keeps a valid citation from compare_to_prior_periods, nested at .current.id', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Runway is now 4 months <cite id="1:runway:_:_"/>.',
        toolResults: [compareResult('1:runway:_:_')],
      }),
    );

    expect(result.answer).toContain('<cite id="1:runway:_:_"/>');
    expect(result.citedStatIds).toEqual(['1:runway:_:_']);
  });

  it('strips a citation whose id matches no tool result', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite id="fabricated"/> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).not.toContain('fabricated');
    expect(result.citedStatIds).toEqual([]);
  });

  it('contributes no id when a tool call returned null', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'I could not find that metric <cite id="anything"/>.',
        toolResults: [getMetricResult('unused', null)],
      }),
    );

    expect(result.answer).not.toContain('anything');
    expect(result.citedStatIds).toEqual([]);
  });

  it('keeps a valid citation and strips a hallucinated one in the same answer', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite id="3:trend:Sales:0"/>, unlike churn <cite id="fabricated"/>.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).toContain('<cite id="3:trend:Sales:0"/>');
    expect(result.answer).not.toContain('fabricated');
    expect(result.citedStatIds).toEqual(['3:trend:Sales:0']);
  });

  it('strips any cite tag when there are zero tool calls', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'You answered directly <cite id="ghost"/>.',
        toolResults: [],
      }),
    );

    expect(result.answer).not.toContain('ghost');
    expect(result.citedStatIds).toEqual([]);
  });

  it('strips a bare cite tag without throwing and without citing it', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite/> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).toContain('Sales grew 12%  this quarter.');
    expect(result.answer).not.toContain('<cite');
    expect(result.citedStatIds).toEqual([]);
  });

  it('normalizes a valid non-self-closing cite to self-closing and drops its enclosed text', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Runway is <cite id="1:runway:_:_">3 months</cite> at this burn.',
        toolResults: [compareResult('1:runway:_:_')],
      }),
    );

    expect(result.answer).toContain('<cite id="1:runway:_:_"/>');
    expect(result.answer).not.toContain('3 months');
    expect(result.citedStatIds).toEqual(['1:runway:_:_']);
  });

  it('strips an invalid non-self-closing cite along with its enclosed text', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite id="fabricated">wrong</cite> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).not.toContain('fabricated');
    expect(result.answer).not.toContain('wrong');
    expect(result.citedStatIds).toEqual([]);
  });

  it('strips a bare non-self-closing cite along with its enclosed text', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew 12% <cite>wrong</cite> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).not.toContain('<cite');
    expect(result.answer).not.toContain('wrong');
    expect(result.citedStatIds).toEqual([]);
  });

  it('resolves a nested cite tag on its own validity instead of collapsing both into one match', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Sales grew <cite id="3:trend:Sales:0">up <cite id="fabricated">wrong</cite> more</cite> this quarter.',
        toolResults: [getMetricResult('3:trend:Sales:0')],
      }),
    );

    expect(result.answer).toContain('<cite id="3:trend:Sales:0"/>');
    expect(result.answer).not.toContain('fabricated');
    expect(result.answer).not.toContain('wrong');
    expect(result.citedStatIds).toEqual(['3:trend:Sales:0']);
  });

  it('drops the enclosed text when the closing tag has a stray space before the bracket', () => {
    const result = assembleQaAnswer(
      loopResult({
        answer: 'Runway is <cite id="1:runway:_:_">3 months</cite > at this burn.',
        toolResults: [compareResult('1:runway:_:_')],
      }),
    );

    expect(result.answer).toContain('<cite id="1:runway:_:_"/>');
    expect(result.answer).not.toContain('3 months');
    expect(result.citedStatIds).toEqual(['1:runway:_:_']);
  });

  it('logs a warning and still returns the answer when a banned imperative is present', () => {
    const result = assembleQaAnswer(loopResult({ answer: 'You should cut costs this month.' }));

    expect(logger.warn).toHaveBeenCalledWith(
      { phrases: [expect.stringMatching(/you\s+should/i)] },
      'Q&A answer contained banned imperative language',
    );
    expect(result.answer).toContain('You should cut costs this month.');
  });

  it('logs every distinct banned phrase, not just the first', () => {
    assembleQaAnswer(loopResult({ answer: 'You should cut costs. Also, I recommend renegotiating rent.' }));

    const [firstArg] = vi.mocked(logger.warn).mock.calls[0]!;
    expect((firstArg as { phrases: string[] }).phrases).toHaveLength(2);
  });

  it('does not warn when the answer stays advisory', () => {
    assembleQaAnswer(loopResult({ answer: 'This might be worth investigating with your accountant.' }));

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('appends AI_DISCLAIMER exactly once', () => {
    const result = assembleQaAnswer(loopResult({ answer: 'Revenue is up.' }));

    const occurrences = result.answer.split(AI_DISCLAIMER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('does not double-append when the answer already echoes the disclaimer verbatim', () => {
    const result = assembleQaAnswer(loopResult({ answer: `Revenue is up.\n\n${AI_DISCLAIMER}` }));

    const occurrences = result.answer.split(AI_DISCLAIMER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('falls back to a no-answer message plus disclaimer when the model returns no text', () => {
    const result = assembleQaAnswer(loopResult({ answer: '' }));

    expect(result.answer.trim().length).toBeGreaterThan(AI_DISCLAIMER.length);
    expect(result.answer).toContain(AI_DISCLAIMER);
  });

  it('passes through termination and turnCount unchanged', () => {
    const result = assembleQaAnswer(loopResult({ termination: 'turn-cap', turnCount: 6 }));

    expect(result.termination).toBe('turn-cap');
    expect(result.turnCount).toBe(6);
  });

  it('passes through "breaker-open" termination and falls back to the no-answer message', () => {
    const result = assembleQaAnswer(loopResult({ termination: 'breaker-open', answer: '' }));

    expect(result.termination).toBe('breaker-open');
    expect(result.answer).toContain(AI_DISCLAIMER);
  });
});
