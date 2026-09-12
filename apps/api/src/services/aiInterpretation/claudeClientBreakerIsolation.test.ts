import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deliberately does NOT mock ../../lib/circuitBreaker.js. claudeClient.test.ts
// replaces CircuitBreaker with a pass-through whose exec just runs the function
// and whose isOpen is always false, so it proves which breaker each provider
// function routes to but never that one path tripping leaves the others working.
// That is what these cover, against the real class.

vi.mock('../../config.js', () => ({
  env: { CLAUDE_API_KEY: 'test-key', CLAUDE_MODEL: 'claude-sonnet-4-5-20250929' },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockComputeCost = vi.fn();
const mockExceedsBudget = vi.fn();
const mockRecordCost = vi.fn();

vi.mock('../../lib/cost.js', () => ({
  computeCost: (...args: unknown[]) => mockComputeCost(...args),
  exceedsBudget: (...args: unknown[]) => mockExceedsBudget(...args),
  recordCost: (...args: unknown[]) => mockRecordCost(...args),
}));

// circuitBreakerState is imported by the real CircuitBreaker, so a partial mock
// of this module has to include it. Mocking at all is what matters here though:
// metrics.ts calls collectDefaultMetrics at module scope with no re-entrancy
// guard, and freshClient() re-evaluates it on every resetModules, which leaves
// behind a PerformanceObserver on 'gc' that is never disconnected.
vi.mock('../../lib/metrics.js', () => ({
  aiCostBudgetExceeded: { inc: vi.fn() },
  aiToolCallsDropped: { inc: vi.fn() },
  circuitBreakerState: { set: vi.fn() },
}));

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class AuthenticationError extends Error {}
  class BadRequestError extends Error {}
  const MockAnthropic = Object.assign(
    vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate, stream: mockStream },
      models: { list: vi.fn() },
    })),
    { AuthenticationError, BadRequestError },
  );
  return { default: MockAnthropic };
});

const OK_RESPONSE = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const TOOLS = [{ name: 'lookup', description: 'test tool', inputSchema: {} }];

// The three breakers are module-scoped singletons, so every test needs a fresh
// module registry or failure counts carry over from the previous one.
async function freshClient() {
  vi.resetModules();
  const claudeClient = await import('./claudeClient.js');
  const { CircuitOpenError } = await import('../../lib/circuitBreaker.js');
  return { claudeClient, CircuitOpenError };
}

async function tripWith(call: () => Promise<unknown>) {
  mockCreate.mockRejectedValue(new Error('upstream boom'));
  for (let i = 0; i < 3; i++) {
    await expect(call()).rejects.toThrow(/External service error: Claude API/);
  }
}

describe('breaker isolation across provider paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockStream.mockReset();
    mockComputeCost.mockReturnValue(0.01);
    mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });
  });

  it('opens only the tool breaker, leaving generate and converse callable', async () => {
    const { claudeClient, CircuitOpenError } = await freshClient();

    await tripWith(() => claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS));

    const callsWhenOpen = mockCreate.mock.calls.length;
    expect(callsWhenOpen).toBe(3);
    await expect(claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS)).rejects.toThrow(
      CircuitOpenError,
    );
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen);

    mockCreate.mockResolvedValue(OK_RESPONSE);
    await expect(claudeClient.generateInterpretation({ system: '', user: 'hi' })).resolves.toBe('ok');
    await expect(
      claudeClient.converseWithTools(null, { system: '', user: 'hi' }, [], []),
    ).resolves.toMatchObject({ text: 'ok', toolCalls: [] });
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen + 2);
  });

  it('opens only the shared breaker, leaving the tool and converse paths callable', async () => {
    const { claudeClient, CircuitOpenError } = await freshClient();

    await tripWith(() => claudeClient.generateInterpretation({ system: '', user: 'hi' }));

    const callsWhenOpen = mockCreate.mock.calls.length;
    expect(callsWhenOpen).toBe(3);
    await expect(claudeClient.generateInterpretation({ system: '', user: 'hi' })).rejects.toThrow(
      CircuitOpenError,
    );
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen);

    mockCreate.mockResolvedValue(OK_RESPONSE);
    await expect(claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS)).resolves.toEqual([]);
    await expect(
      claudeClient.converseWithTools(null, { system: '', user: 'hi' }, [], []),
    ).resolves.toMatchObject({ text: 'ok', toolCalls: [] });
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen + 2);
  });

  it('opens only the converse breaker, leaving generate and the tool path callable', async () => {
    const { claudeClient, CircuitOpenError } = await freshClient();

    await tripWith(() => claudeClient.converseWithTools(null, { system: '', user: 'hi' }, [], []));

    const callsWhenOpen = mockCreate.mock.calls.length;
    expect(callsWhenOpen).toBe(3);
    await expect(
      claudeClient.converseWithTools(null, { system: '', user: 'hi' }, [], []),
    ).rejects.toThrow(CircuitOpenError);
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen);

    mockCreate.mockResolvedValue(OK_RESPONSE);
    await expect(claudeClient.generateInterpretation({ system: '', user: 'hi' })).resolves.toBe('ok');
    await expect(claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS)).resolves.toEqual([]);
    expect(mockCreate.mock.calls.length).toBe(callsWhenOpen + 2);
  });

  // DW-206. anthropicStream is the other consumer of the shared breaker. Routing
  // is covered in claudeClient.test.ts, but nothing proved an open shared breaker
  // sheds the SSE path instead of letting it hang on a dead upstream.
  it('trips the shared breaker from the stream path and sheds generate with it', async () => {
    const { claudeClient, CircuitOpenError } = await freshClient();

    mockStream.mockImplementation(() => {
      throw new Error('upstream boom');
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        claudeClient.streamInterpretation({ system: '', user: 'hi' }, () => {}),
      ).rejects.toThrow('upstream boom');
    }

    // Both sit on `breaker`, so the trip has to shed the stream and generate alike.
    await expect(
      claudeClient.streamInterpretation({ system: '', user: 'hi' }, () => {}),
    ).rejects.toThrow(CircuitOpenError);
    await expect(claudeClient.generateInterpretation({ system: '', user: 'hi' })).rejects.toThrow(
      CircuitOpenError,
    );

    mockCreate.mockResolvedValue(OK_RESPONSE);
    await expect(claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS)).resolves.toEqual([]);
  });

  // The other half of isIgnored. AbortedByClient was only ever checked as a
  // captured predicate against a breaker that cannot open, so nothing showed that
  // one user closing a tab does not spend the budget for everyone else.
  it('does not let client aborts on the stream open the shared breaker', async () => {
    const { claudeClient } = await freshClient();

    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      controller.abort();
      mockStream.mockImplementation(() => {
        throw new Error('stream torn down');
      });
      await expect(
        claudeClient.streamInterpretation({ system: '', user: 'hi' }, () => {}, controller.signal),
      ).rejects.toThrow('aborted by client');
    }

    mockCreate.mockResolvedValue(OK_RESPONSE);
    await expect(claudeClient.generateInterpretation({ system: '', user: 'hi' })).resolves.toBe('ok');
  });

  // DW-205. buildConversationMessages runs before runConverseInBreaker on purpose:
  // a mismatched state/toolResults pair is a caller bug, not a Claude outage, and
  // must not spend the breaker's failure budget. Moving that call inside the
  // breaker is the regression this pins.
  it('does not let caller-contract violations open the converse breaker', async () => {
    const { claudeClient } = await freshClient();
    mockCreate.mockResolvedValue(OK_RESPONSE);

    for (let i = 0; i < 3; i++) {
      await expect(
        claudeClient.converseWithTools('not an array', { system: '', user: 'q' }, [], []),
      ).rejects.toThrow(/state must be the message array/);
    }

    // Nothing reached the SDK, so none of those could have been a Claude failure.
    expect(mockCreate).not.toHaveBeenCalled();

    await expect(
      claudeClient.converseWithTools(null, { system: '', user: 'q' }, [], []),
    ).resolves.toMatchObject({ text: 'ok', toolCalls: [] });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // isIgnored covers CostBudgetExceededError, so a run of refused-on-cost calls
  // must not spend the breaker's failure budget.
  it('does not let cost-gate rejections open the tool breaker', async () => {
    const { claudeClient } = await freshClient();
    const { CostBudgetExceededError } = await import('../../lib/appError.js');

    mockCreate.mockResolvedValue(OK_RESPONSE);
    mockExceedsBudget.mockReturnValue({ exceeded: true, observed: 9.99, cap: 1, median: 0.5 });

    for (let i = 0; i < 3; i++) {
      await expect(
        claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS),
      ).rejects.toThrow(CostBudgetExceededError);
    }

    const callsBefore = mockCreate.mock.calls.length;
    await expect(claudeClient.generateWithTools({ system: '', user: 'hi' }, TOOLS)).rejects.toThrow(
      CostBudgetExceededError,
    );
    expect(mockCreate.mock.calls.length).toBe(callsBefore + 1);
  });
});
