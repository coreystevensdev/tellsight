import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockComputeCost = vi.fn();
const mockExceedsBudget = vi.fn();
vi.mock('../../lib/cost.js', () => ({
  computeCost: (...args: unknown[]) => mockComputeCost(...args),
  exceedsBudget: (...args: unknown[]) => mockExceedsBudget(...args),
  ABSOLUTE_CEILING_USD: 1.0,
}));

const mockConverseWithTools = vi.fn();
vi.mock('../aiInterpretation/claudeClient.js', () => ({
  converseWithTools: (...args: unknown[]) => mockConverseWithTools(...args),
}));

const mockGetMetricWithTrend = vi.fn();
const mockCompareToPriorPeriods = vi.fn();
const mockCreateToolCallCache = vi.fn(() => ({ context: new Map(), stat: new Map() }));
vi.mock('./interpretationTools.js', () => ({
  GET_METRIC_WITH_TREND_TOOL: {
    name: 'get_metric_with_trend',
    description: 'test tool',
    inputSchema: { type: 'object' },
  },
  COMPARE_TO_PRIOR_PERIODS_TOOL: {
    name: 'compare_to_prior_periods',
    description: 'test tool',
    inputSchema: { type: 'object' },
  },
  TREND_CARRYING_STAT_TYPES: [
    'trend',
    'year_over_year',
    'margin_trend',
    'seasonal_projection',
    'cash_flow',
    'runway',
    'break_even',
    'cash_forecast',
  ],
  getMetricWithTrend: (...args: unknown[]) => mockGetMetricWithTrend(...args),
  compareToPriorPeriods: (...args: unknown[]) => mockCompareToPriorPeriods(...args),
  createToolCallCache: () => mockCreateToolCallCache(),
}));

import { logger } from '../../lib/logger.js';
import { CostBudgetExceededError } from '../../lib/appError.js';
import { runQaLoop, MAX_TOOL_TURNS, MAX_LOOP_COST_USD } from './qaLoop.js';
import type { ToolContext } from './interpretationTools.js';

const CTX: ToolContext = { orgId: 1, isAdmin: false, datasetId: 7, now: new Date('2026-04-13T00:00:00Z') };
const QUESTION = 'How is revenue trending?';

function turn(over: Partial<{ state: unknown; toolCalls: unknown[]; text: string; usage: { inputTokens: number; outputTokens: number } }> = {}) {
  return {
    state: 'opaque-state',
    toolCalls: [],
    text: '',
    usage: { inputTokens: 100, outputTokens: 50 },
    ...over,
  };
}

function toolCall(over: Partial<{ id: string; name: string; input: unknown }> = {}) {
  return { id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' }, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeCost.mockReturnValue(0.01);
  mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });
  mockGetMetricWithTrend.mockResolvedValue({ found: true, stat: { id: '1:trend:Sales:0', statType: 'trend', category: 'Sales', value: 0.1, details: {} } });
  mockCompareToPriorPeriods.mockResolvedValue({ found: true, current: { id: '1:trend:Sales:0' }, hasHistory: false });
});

describe('runQaLoop', () => {
  it('ends on turn 1 with termination "answered" when the model returns text with no tool call', async () => {
    mockConverseWithTools.mockResolvedValueOnce(turn({ text: 'Revenue is up 12% this quarter.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(result).toEqual({
      answer: 'Revenue is up 12% this quarter.',
      toolResults: [],
      termination: 'answered',
      turnCount: 1,
      narration: [],
    });
    expect(mockConverseWithTools).toHaveBeenCalledTimes(1);
    expect(mockExceedsBudget).not.toHaveBeenCalled();
  });

  it('passes state: null and tools: [] toolResultInputs on the first call', async () => {
    mockConverseWithTools.mockResolvedValueOnce(turn({ text: 'ok' }));

    await runQaLoop(QUESTION, CTX);

    const [state, input, tools, toolResultInputs] = mockConverseWithTools.mock.calls[0]!;
    expect(state).toBeNull();
    expect(input).toMatchObject({ user: QUESTION });
    expect((tools as unknown[]).map((t) => (t as { name: string }).name)).toEqual([
      'get_metric_with_trend',
      'compare_to_prior_periods',
    ]);
    expect(toolResultInputs).toEqual([]);
  });

  it('dispatches a valid tool call with the caller-supplied ToolContext unchanged', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }))
      .mockResolvedValueOnce(turn({ text: 'Sales grew 10%.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(mockGetMetricWithTrend).toHaveBeenCalledWith({ statType: 'trend', category: undefined }, CTX, expect.any(Object), undefined);
    expect(result.toolResults).toEqual([
      {
        name: 'get_metric_with_trend',
        input: { statType: 'trend' },
        output: { id: '1:trend:Sales:0', statType: 'trend', category: 'Sales', value: 0.1, details: {} },
      },
    ]);
    expect(result.termination).toBe('answered');
    expect(result.turnCount).toBe(2);
  });

  it('dispatches compare_to_prior_periods with validated input', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(
        turn({ toolCalls: [toolCall({ id: 'call_x', name: 'compare_to_prior_periods', input: { statType: 'runway', periodsBack: 3 } })] }),
      )
      .mockResolvedValueOnce(turn({ text: 'Runway has shrunk over the last 3 periods.' }));

    await runQaLoop(QUESTION, CTX);

    expect(mockCompareToPriorPeriods).toHaveBeenCalledWith({ statType: 'runway', category: undefined, periodsBack: 3 }, CTX, expect.any(Object), undefined);
  });

  it('sends null to the model for both a not_found and a suppressed getMetricWithTrend result, logging only the suppressed case', async () => {
    mockGetMetricWithTrend.mockResolvedValueOnce({ found: false, reason: 'not_found' });
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_1' })] }))
      .mockResolvedValueOnce(turn({ text: 'not found' }));
    await runQaLoop(QUESTION, CTX);
    expect(mockConverseWithTools.mock.calls[1]![3]).toEqual([{ toolCallId: 'call_1', output: null }]);
    expect(logger.info).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockComputeCost.mockReturnValue(0.01);
    mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });
    mockGetMetricWithTrend.mockResolvedValueOnce({ found: false, reason: 'suppressed' });
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_2' })] }))
      .mockResolvedValueOnce(turn({ text: 'suppressed' }));
    await runQaLoop(QUESTION, CTX);
    expect(mockConverseWithTools.mock.calls[1]![3]).toEqual([{ toolCallId: 'call_2', output: null }]);
    expect(logger.info).toHaveBeenCalledWith(
      { toolName: 'get_metric_with_trend', orgId: CTX.orgId, datasetId: CTX.datasetId },
      'Q&A tool result suppressed by an active correction',
    );
  });

  it('unwraps a found compare_to_prior_periods result to the bare current/hasHistory/priorPeriods shape, dropping the found tag', async () => {
    mockCompareToPriorPeriods.mockResolvedValueOnce({
      found: true,
      current: { id: '1:runway:0' },
      hasHistory: true,
      priorPeriods: [{ weekStart: '2026-04-06T00:00:00.000Z', value: 4 }],
    });
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_3', name: 'compare_to_prior_periods', input: { statType: 'runway' } })] }))
      .mockResolvedValueOnce(turn({ text: 'done' }));

    await runQaLoop(QUESTION, CTX);

    expect(mockConverseWithTools.mock.calls[1]![3]).toEqual([
      {
        toolCallId: 'call_3',
        output: { current: { id: '1:runway:0' }, hasHistory: true, priorPeriods: [{ weekStart: '2026-04-06T00:00:00.000Z', value: 4 }] },
      },
    ]);
  });

  it('feeds the second turn a tool_result keyed by the call id', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_42' })] }))
      .mockResolvedValueOnce(turn({ text: 'done' }));

    await runQaLoop(QUESTION, CTX);

    const secondCallArgs = mockConverseWithTools.mock.calls[1]!;
    expect(secondCallArgs[3]).toEqual([
      { toolCallId: 'call_42', output: { id: '1:trend:Sales:0', statType: 'trend', category: 'Sales', value: 0.1, details: {} } },
    ]);
  });

  it('skips a malformed tool call, logs it, and keeps the loop going with an error tool_result', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_bad', input: { statType: 'not-a-real-type' } })] }))
      .mockResolvedValueOnce(turn({ text: 'I could not find that metric.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(mockGetMetricWithTrend).not.toHaveBeenCalled();
    expect(result.toolResults).toEqual([]);
    expect(result.termination).toBe('answered');
    expect(result.turnCount).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'get_metric_with_trend call had an invalid statType');

    const secondCallArgs = mockConverseWithTools.mock.calls[1]!;
    expect(secondCallArgs[3]).toEqual([{ toolCallId: 'call_bad', output: { error: 'tool call rejected' }, isError: true }]);
  });

  it('skips an unrecognized tool name, logs it, and keeps the loop going', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_ghost', name: 'delete_everything' })] }))
      .mockResolvedValueOnce(turn({ text: 'done' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(mockGetMetricWithTrend).not.toHaveBeenCalled();
    expect(mockCompareToPriorPeriods).not.toHaveBeenCalled();
    expect(result.termination).toBe('answered');
    expect(logger.warn).toHaveBeenCalledWith({ toolName: 'delete_everything' }, 'Q&A loop received an unrecognized tool call');
  });

  it('collects narration text from tool-calling turns, in order, without duplicating the terminal answer', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ text: 'Let me check the trend first.', toolCalls: [toolCall({ id: 'call_1' })] }))
      .mockResolvedValueOnce(
        turn({ toolCalls: [toolCall({ id: 'call_2', name: 'compare_to_prior_periods', input: { statType: 'runway' } })] }),
      )
      .mockResolvedValueOnce(turn({ text: 'Now comparing to prior periods.', toolCalls: [toolCall({ id: 'call_3' })] }))
      .mockResolvedValueOnce(turn({ text: 'Revenue is up 12% this quarter.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.narration).toEqual(['Let me check the trend first.', 'Now comparing to prior periods.']);
    expect(result.answer).toBe('Revenue is up 12% this quarter.');
  });

  it('leaves narration empty when every tool-calling turn returns empty text', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_1' })] }))
      .mockResolvedValueOnce(turn({ text: 'Revenue is up 12% this quarter.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.narration).toEqual([]);
  });

  it('forces a no-tools final turn once the turn cap is reached', async () => {
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      mockConverseWithTools.mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: `call_${i}` })] }));
    }
    mockConverseWithTools.mockResolvedValueOnce(turn({ text: 'Here is what I found across all those lookups.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.termination).toBe('turn-cap');
    expect(result.turnCount).toBe(MAX_TOOL_TURNS + 1);
    expect(mockConverseWithTools).toHaveBeenCalledTimes(MAX_TOOL_TURNS + 1);

    const finalCallArgs = mockConverseWithTools.mock.calls[MAX_TOOL_TURNS]!;
    expect(finalCallArgs[2]).toEqual([]);
  });

  it('stops issuing tool-enabled turns once cumulative cost trips the budget, forcing a no-tools final turn', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }))
      .mockResolvedValueOnce(turn({ text: 'Based on what I found so far, revenue is trending up.' }));
    mockExceedsBudget.mockReturnValueOnce({ exceeded: true, observed: 5, cap: 1, median: 0.1 });

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.termination).toBe('cost-exceeded');
    expect(result.turnCount).toBe(2);
    expect(mockConverseWithTools).toHaveBeenCalledTimes(2);

    const finalCallArgs = mockConverseWithTools.mock.calls[1]!;
    expect(finalCallArgs[2]).toEqual([]);
  });

  it('stops issuing tool-enabled turns once totalCost crosses the flat MAX_LOOP_COST_USD ceiling, even though every turn stays under the per-call cap', async () => {
    // Each turn costs just under the real per-call ceiling (mocked ABSOLUTE_CEILING_USD
    // is 1.0), so exceedsBudget's average check never trips, but three of them
    // together clear the flat ceiling well before MAX_TOOL_TURNS would.
    const costPerTurn = 0.99;

    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_1' })] }))
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_2' })] }))
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_3' })] }))
      .mockResolvedValueOnce(turn({ text: 'Here is what I found before the loop cost ceiling tripped.' }));
    mockComputeCost.mockReturnValueOnce(costPerTurn).mockReturnValueOnce(costPerTurn).mockReturnValueOnce(costPerTurn);
    mockExceedsBudget
      .mockReturnValueOnce({ exceeded: false, observed: costPerTurn, cap: 1.5, median: 0.5 })
      .mockReturnValueOnce({ exceeded: false, observed: costPerTurn, cap: 1.5, median: 0.5 })
      .mockReturnValueOnce({ exceeded: false, observed: costPerTurn, cap: 1.5, median: 0.5 });

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.termination).toBe('cost-exceeded');
    expect(result.turnCount).toBe(4);
    expect(result.turnCount).toBeLessThan(MAX_TOOL_TURNS);
    expect(mockConverseWithTools).toHaveBeenCalledTimes(4);

    const finalCallArgs = mockConverseWithTools.mock.calls[3]!;
    expect(finalCallArgs[2]).toEqual([]);
  });

  it('does not trip cost-exceeded when totalCost lands exactly on MAX_LOOP_COST_USD (strictly-greater, not greater-or-equal)', async () => {
    const costPerTurn = MAX_LOOP_COST_USD / 2;

    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_1' })] }))
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall({ id: 'call_2' })] }))
      .mockResolvedValueOnce(turn({ text: 'Landed exactly on the ceiling and kept going.' }));
    mockComputeCost.mockReturnValueOnce(costPerTurn).mockReturnValueOnce(costPerTurn);
    mockExceedsBudget
      .mockReturnValueOnce({ exceeded: false, observed: costPerTurn, cap: 1.5, median: 0.5 })
      .mockReturnValueOnce({ exceeded: false, observed: costPerTurn, cap: 1.5, median: 0.5 });

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.termination).toBe('answered');
    expect(result.turnCount).toBe(3);
  });

  it('recovers from a single-turn cost-anomaly by forcing a no-tools final turn', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }))
      .mockRejectedValueOnce(new CostBudgetExceededError(2.0, 1.0))
      .mockResolvedValueOnce(turn({ text: 'Here is what I found before that turn got too expensive.' }));

    const result = await runQaLoop(QUESTION, CTX);

    expect(result.termination).toBe('cost-exceeded');
    expect(result.answer).toBe('Here is what I found before that turn got too expensive.');
    expect(mockConverseWithTools).toHaveBeenCalledTimes(3);

    const finalCallArgs = mockConverseWithTools.mock.calls[2]!;
    expect(finalCallArgs[2]).toEqual([]);
  });

  it('propagates a second cost-anomaly on the forced retry instead of retrying again', async () => {
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }))
      .mockRejectedValueOnce(new CostBudgetExceededError(2.0, 1.0))
      .mockRejectedValueOnce(new CostBudgetExceededError(3.0, 1.0));

    await expect(runQaLoop(QUESTION, CTX)).rejects.toThrow('exceeded safety cap');
    expect(mockConverseWithTools).toHaveBeenCalledTimes(3);
  });

  it('propagates a provider error (e.g. an abort) without issuing further turns', async () => {
    class AbortedByClient extends Error {
      constructor() {
        super('aborted by client');
      }
    }
    mockConverseWithTools
      .mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }))
      .mockRejectedValueOnce(new AbortedByClient());

    const controller = new AbortController();

    await expect(runQaLoop(QUESTION, CTX, controller.signal)).rejects.toThrow('aborted by client');
    expect(mockConverseWithTools).toHaveBeenCalledTimes(2);
    expect(mockConverseWithTools.mock.calls[1]![4]).toBe(controller.signal);
  });

  it('propagates a genuine provider error on the very first turn', async () => {
    mockConverseWithTools.mockRejectedValueOnce(new Error('Claude API is down'));

    await expect(runQaLoop(QUESTION, CTX)).rejects.toThrow('Claude API is down');
  });

  it('dispatches two tool calls in one turn concurrently, both starting before either resolves, and keeps turn.toolCalls order in the result regardless of resolution order', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const firstCall = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondCall = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    mockGetMetricWithTrend.mockReturnValueOnce(firstCall);
    mockCompareToPriorPeriods.mockReturnValueOnce(secondCall);

    mockConverseWithTools
      .mockResolvedValueOnce(
        turn({
          toolCalls: [
            toolCall({ id: 'call_a', name: 'get_metric_with_trend' }),
            toolCall({ id: 'call_b', name: 'compare_to_prior_periods', input: { statType: 'runway' } }),
          ],
        }),
      )
      .mockResolvedValueOnce(turn({ text: 'done' }));

    const resultPromise = runQaLoop(QUESTION, CTX);

    // Flush enough microtask ticks for runQaLoop's continuation past the
    // first converseWithTools call to reach the Promise.all dispatch, without
    // letting either deferred tool call resolve.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(mockGetMetricWithTrend).toHaveBeenCalledTimes(1);
    expect(mockCompareToPriorPeriods).toHaveBeenCalledTimes(1);

    // Same cache instance reaches both calls in the turn -- a regression that
    // built a fresh cache per dispatch would defeat the whole point of this change.
    expect(mockGetMetricWithTrend.mock.calls[0]![2]).toBe(mockCompareToPriorPeriods.mock.calls[0]![2]);

    // Resolve out of call order (second, then first) -- the result must still
    // land in turn.toolCalls order, proving the ordering doesn't just happen
    // to match because this test resolved them in order.
    resolveSecond({ found: true, current: { id: '1:runway:0' }, hasHistory: false });
    resolveFirst({ found: true, stat: { id: '1:trend:Sales:0', statType: 'trend', category: 'Sales', value: 0.1, details: {} } });

    const result = await resultPromise;

    expect(result.toolResults.map((r) => r.name)).toEqual(['get_metric_with_trend', 'compare_to_prior_periods']);
    expect(mockConverseWithTools.mock.calls[1]![3]).toEqual([
      { toolCallId: 'call_a', output: { id: '1:trend:Sales:0', statType: 'trend', category: 'Sales', value: 0.1, details: {} } },
      { toolCallId: 'call_b', output: { current: { id: '1:runway:0' }, hasHistory: false } },
    ]);
  });

  it('propagates an error thrown during tool dispatch without issuing another turn', async () => {
    class AbortedByClient extends Error {
      constructor() {
        super('aborted mid-dispatch');
      }
    }
    mockGetMetricWithTrend.mockRejectedValueOnce(new AbortedByClient());
    mockConverseWithTools.mockResolvedValueOnce(turn({ toolCalls: [toolCall()] }));

    const controller = new AbortController();

    await expect(runQaLoop(QUESTION, CTX, controller.signal)).rejects.toThrow('aborted mid-dispatch');
    expect(mockConverseWithTools).toHaveBeenCalledTimes(1);
  });
});
