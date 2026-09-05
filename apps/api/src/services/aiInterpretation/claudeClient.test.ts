import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  env: {
    CLAUDE_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface BreakerOpts {
  name: string;
  threshold: number;
  cooldownMs: number;
  isIgnored: (err: unknown) => boolean;
}

// Captures the whole options object, not just the name. Reading only opts.name
// meant threshold, cooldownMs and isIgnored were unasserted at all three
// construction sites, and replacing isIgnored with () => false left the entire
// API suite green.
const mockBreakerInstances: Array<{
  name: string;
  opts: BreakerOpts;
  execSpy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../lib/circuitBreaker.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation((opts: BreakerOpts) => {
    const execSpy = vi.fn((fn: () => Promise<unknown>) => fn());
    mockBreakerInstances.push({ name: opts.name, opts, execSpy });
    return { exec: execSpy, isOpen: () => false };
  }),
  CircuitOpenError: class CircuitOpenError extends Error {
    readonly code = 'CIRCUIT_OPEN';
    constructor(name: string) { super(`Circuit breaker "${name}" is open`); }
  },
}));

const mockComputeCost = vi.fn();
const mockExceedsBudget = vi.fn();
const mockRecordCost = vi.fn();

vi.mock('../../lib/cost.js', () => ({
  computeCost: (...args: unknown[]) => mockComputeCost(...args),
  exceedsBudget: (...args: unknown[]) => mockExceedsBudget(...args),
  recordCost: (...args: unknown[]) => mockRecordCost(...args),
}));

const mockBudgetMetric = { inc: vi.fn() };
const mockDropMetric = { inc: vi.fn() };
vi.mock('../../lib/metrics.js', () => ({
  aiCostBudgetExceeded: mockBudgetMetric,
  aiToolCallsDropped: mockDropMetric,
}));

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class AuthenticationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'AuthenticationError';
    }
  }
  class BadRequestError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'BadRequestError';
    }
  }

  const MockAnthropic = Object.assign(
    vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate, stream: mockStream },
    })),
    { AuthenticationError, BadRequestError },
  );

  return { default: MockAnthropic };
});

import { logger } from '../../lib/logger.js';

describe('circuit breaker construction options', () => {
  async function breakerOpts() {
    vi.resetModules();
    vi.clearAllMocks();
    mockBreakerInstances.length = 0;

    mockComputeCost.mockReturnValue(0.01);
    mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });

    const claudeClient = await import('./claudeClient.js');
    return { opts: mockBreakerInstances.map((b) => b.opts), claudeClient };
  }

  // Anthropic's SDK already retries twice per call, so 3 trips is roughly 9
  // failed attempts over ~45s of real outage before a breaker opens. A lower
  // number turns a transient blip into a 30s outage for every user.
  it('gives all three breakers the same threshold and cooldown', async () => {
    const { opts } = await breakerOpts();

    expect(opts).toHaveLength(3);
    for (const o of opts) {
      expect(o.threshold).toBe(3);
      expect(o.cooldownMs).toBe(30_000);
    }
  });

  it('gives all three breakers the same isIgnored predicate', async () => {
    const { opts } = await breakerOpts();

    for (const o of opts) expect(typeof o.isIgnored).toBe('function');
    expect(opts[1]!.isIgnored).toBe(opts[0]!.isIgnored);
    expect(opts[2]!.isIgnored).toBe(opts[0]!.isIgnored);
  });

  // A cost-cap trip is the system working, not Anthropic failing. Counting it
  // means three users hitting the cap opens the breaker and everyone else gets
  // AI_UNAVAILABLE for 30s.
  it('does not count a budget trip against the breaker', async () => {
    const { opts } = await breakerOpts();
    const { CostBudgetExceededError } = await import('../../lib/appError.js');

    expect(opts[0]!.isIgnored(new CostBudgetExceededError(1.23, 1.0))).toBe(true);
  });

  it('does count a real upstream failure', async () => {
    const { opts } = await breakerOpts();

    expect(opts[0]!.isIgnored(new Error('502 from Anthropic'))).toBe(false);
    expect(opts[0]!.isIgnored(new TypeError('undefined is not a function'))).toBe(false);
    expect(opts[0]!.isIgnored('not even an error')).toBe(false);
  });

  // AbortedByClient is module-private, so the only way to check it is to make
  // the client throw one and hand that instance back to the predicate. Three
  // users pressing Cancel must not open the breaker for everybody else.
  it('does not count a client-side abort against the breaker', async () => {
    const { opts, claudeClient } = await breakerOpts();

    const controller = new AbortController();
    controller.abort();
    // Any stream failure while the signal is aborted takes the abort branch.
    mockStream.mockImplementation(() => {
      throw new Error('stream torn down');
    });

    const thrown = await claudeClient
      .streamInterpretation({ system: '', user: 'x' }, () => {}, controller.signal)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(opts[0]!.isIgnored(thrown)).toBe(true);
  });
});

describe('circuit breaker wiring', () => {
  it('routes generate/stream through the shared breaker, generateTool and converseWithTools each through their own', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockBreakerInstances.length = 0;

    mockComputeCost.mockReturnValue(0.01);
    mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const claudeClient = await import('./claudeClient.js');

    expect(mockBreakerInstances).toHaveLength(3);
    const shared = mockBreakerInstances.find((b) => b.name === 'claude-api');
    const tool = mockBreakerInstances.find((b) => b.name === 'claude-api-tool');
    const converse = mockBreakerInstances.find((b) => b.name === 'claude-api-converse');
    if (!shared || !tool || !converse) throw new Error('expected a shared, a tool-scoped, and a converse-scoped breaker instance');

    await claudeClient.generateInterpretation({ system: '', user: 'hi' });
    expect(shared.execSpy).toHaveBeenCalledTimes(1);
    expect(tool.execSpy).not.toHaveBeenCalled();
    expect(converse.execSpy).not.toHaveBeenCalled();

    await claudeClient.generateWithTools({ system: '', user: 'hi' }, [
      { name: 'lookup', description: 'test tool', inputSchema: {} },
    ]);
    expect(tool.execSpy).toHaveBeenCalledTimes(1);
    expect(shared.execSpy).toHaveBeenCalledTimes(1);
    expect(converse.execSpy).not.toHaveBeenCalled();

    await claudeClient.converseWithTools(null, { system: '', user: 'hi' }, [], []);
    expect(converse.execSpy).toHaveBeenCalledTimes(1);
    expect(shared.execSpy).toHaveBeenCalledTimes(1);
    expect(tool.execSpy).toHaveBeenCalledTimes(1);
  });
});

describe('generateInterpretation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: cost is small, budget is fine. Tests exercising the cost path
    // override these explicitly.
    mockComputeCost.mockReturnValue(0.018);
    mockExceedsBudget.mockReturnValue({
      exceeded: false,
      observed: 0.018,
      cap: null,
      median: null,
    });
  });

  it('returns text from Claude response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Revenue is growing steadily.' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    const result = await generateInterpretation({ system: '', user: 'analyze this data' });

    expect(result).toBe('Revenue is growing steadily.');
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'analyze this data' }],
    });
  });

  it('logs token usage after successful response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Analysis here.' }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    await generateInterpretation({ system: '', user: 'test prompt' });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { input_tokens: 200, output_tokens: 100 },
      }),
      'Claude API response received',
    );
  });

  it('returns empty string for non-text content blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    const result = await generateInterpretation({ system: '', user: 'prompt' });

    expect(result).toBe('');
  });

  it('wraps API errors in ExternalServiceError', async () => {
    mockCreate.mockRejectedValue(new Error('connection timeout'));

    const { generateInterpretation } = await import('./claudeClient.js');

    await expect(generateInterpretation({ system: '', user: 'prompt' })).rejects.toThrow(
      'External service error: Claude API',
    );
  });

  it('logs non-retryable errors at error level', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const authErr = new (Anthropic as unknown as { AuthenticationError: new (msg: string) => Error }).AuthenticationError('Invalid API key');
    mockCreate.mockRejectedValue(authErr);

    const { generateInterpretation } = await import('./claudeClient.js');

    await expect(generateInterpretation({ system: '', user: 'prompt' })).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Invalid API key' }),
      'Claude API non-retryable error',
    );
  });

  it('logs retryable errors at warn level', async () => {
    const genericErr = new Error('Server overloaded');
    mockCreate.mockRejectedValue(genericErr);

    const { generateInterpretation } = await import('./claudeClient.js');

    await expect(generateInterpretation({ system: '', user: 'prompt' })).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Server overloaded' }),
      'Claude API retryable error exhausted',
    );
  });

  it('records cost into history on successful generate', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    await generateInterpretation({ system: '', user: 'prompt' });

    expect(mockRecordCost).toHaveBeenCalledWith(0.018);
    expect(mockBudgetMetric.inc).not.toHaveBeenCalled();
  });

  it('throws CostBudgetExceededError when generate cost exceeds budget', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'expensive response' }],
      usage: { input_tokens: 100000, output_tokens: 100000 },
    });
    mockComputeCost.mockReturnValue(2.0);
    mockExceedsBudget.mockReturnValue({
      exceeded: true,
      observed: 2.0,
      cap: 1.0,
      median: 0.05,
    });

    const { generateInterpretation } = await import('./claudeClient.js');

    await expect(generateInterpretation({ system: '', user: 'prompt' })).rejects.toThrow('exceeded safety cap');
    expect(mockBudgetMetric.inc).toHaveBeenCalledWith({ caller: 'generate' });
    expect(mockRecordCost).not.toHaveBeenCalled();
  });

  it('does not wrap CostBudgetExceededError as ExternalServiceError', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'expensive' }],
      usage: { input_tokens: 100000, output_tokens: 100000 },
    });
    mockComputeCost.mockReturnValue(2.0);
    mockExceedsBudget.mockReturnValue({
      exceeded: true,
      observed: 2.0,
      cap: 1.0,
      median: 0.05,
    });

    const { generateInterpretation } = await import('./claudeClient.js');

    // The thrown error should retain the COST_BUDGET_EXCEEDED code, not get
    // re-wrapped as External Service Error (502). The error handler routes
    // 503 from here.
    await expect(generateInterpretation({ system: '', user: 'prompt' })).rejects.toMatchObject({
      code: 'COST_BUDGET_EXCEEDED',
      statusCode: 503,
    });
  });

  it('skips cost path entirely when computeCost returns null (unknown model)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
    });
    mockComputeCost.mockReturnValue(null);

    const { generateInterpretation } = await import('./claudeClient.js');
    await generateInterpretation({ system: '', user: 'prompt' });

    expect(mockExceedsBudget).not.toHaveBeenCalled();
    expect(mockRecordCost).not.toHaveBeenCalled();
  });

  it('attaches cache_control to system block when system is non-empty', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'analysis' }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    await generateInterpretation({
      system: 'You are an analyst. Follow these rules carefully.',
      user: 'Here is the data.',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: [
          {
            type: 'text',
            text: 'You are an analyst. Follow these rules carefully.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'Here is the data.' }],
      }),
    );
  });

  it('omits system field entirely when system is empty (no caching)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { generateInterpretation } = await import('./claudeClient.js');
    await generateInterpretation({ system: '', user: 'just a user message' });

    const calledWith = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledWith).not.toHaveProperty('system');
    expect(calledWith.messages).toEqual([{ role: 'user', content: 'just a user message' }]);
  });
});

function createMockStream(chunks: string[], finalMessage: unknown) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const stream = {
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return stream;
    },
    abort: vi.fn(),
    async finalMessage() {
      // fire text events before resolving
      for (const chunk of chunks) {
        const cbs = listeners.get('text') ?? [];
        for (const cb of cbs) cb(chunk);
      }
      const endCbs = listeners.get('end') ?? [];
      for (const cb of endCbs) cb();
      return finalMessage;
    },
  };

  return stream;
}

describe('streamInterpretation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeCost.mockReturnValue(0.018);
    mockExceedsBudget.mockReturnValue({
      exceeded: false,
      observed: 0.018,
      cap: null,
      median: null,
    });
  });

  it('streams text chunks and returns full result', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'Hello world' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    const stream = createMockStream(['Hello ', 'world'], finalMsg);
    mockStream.mockReturnValue(stream);

    const { streamInterpretation } = await import('./claudeClient.js');
    const deltas: string[] = [];
    const result = await streamInterpretation({ system: '', user: 'test' }, (d) => deltas.push(d));

    expect(deltas).toEqual(['Hello ', 'world']);
    expect(result).toEqual({
      fullText: 'Hello world',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('logs stream completion', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    };
    mockStream.mockReturnValue(createMockStream(['done'], finalMsg));

    const { streamInterpretation } = await import('./claudeClient.js');
    await streamInterpretation({ system: '', user: 'test' }, () => {});

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ usage: finalMsg.usage }),
      'Claude API stream completed',
    );
  });

  it('aborts stream when signal fires', async () => {
    const controller = new AbortController();
    const finalMsg = {
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const stream = createMockStream([], finalMsg);
    stream.abort = vi.fn();
    mockStream.mockReturnValue(stream);

    const { streamInterpretation } = await import('./claudeClient.js');
    const promise = streamInterpretation({ system: '', user: 'test' }, () => {}, controller.signal);

    // stream completes normally here since abort happens after
    await promise;

    // verify abort listener was wired
    controller.abort();
    // the 'end' event already fired, so the listener was removed
  });

  it('re-throws raw errors for upstream instanceof checks', async () => {
    mockStream.mockReturnValue({
      on: () => ({}),
      abort: vi.fn(),
      finalMessage: () => Promise.reject(new Error('stream failed')),
    });

    const { streamInterpretation } = await import('./claudeClient.js');

    await expect(streamInterpretation({ system: '', user: 'test' }, () => {})).rejects.toThrow('stream failed');
  });

  it('records cost into history on successful stream', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
    };
    mockStream.mockReturnValue(createMockStream(['done'], finalMsg));

    const { streamInterpretation } = await import('./claudeClient.js');
    await streamInterpretation({ system: '', user: 'test' }, () => {});

    expect(mockRecordCost).toHaveBeenCalledWith(0.018);
    expect(mockBudgetMetric.inc).not.toHaveBeenCalled();
  });

  it('logs but does not throw when stream cost exceeds budget', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'expensive answer already shipped' }],
      usage: { input_tokens: 100000, output_tokens: 100000 },
    };
    mockStream.mockReturnValue(createMockStream(['expensive ', 'answer ', 'already shipped'], finalMsg));
    mockComputeCost.mockReturnValue(2.0);
    mockExceedsBudget.mockReturnValue({
      exceeded: true,
      observed: 2.0,
      cap: 1.0,
      median: 0.05,
    });

    const { streamInterpretation } = await import('./claudeClient.js');

    // Critical: streaming MUST NOT throw on overrun, content already shipped.
    const result = await streamInterpretation({ system: '', user: 'test' }, () => {});

    expect(result.fullText).toBe('expensive answer already shipped');
    expect(mockBudgetMetric.inc).toHaveBeenCalledWith({ caller: 'stream' });
    expect(mockRecordCost).not.toHaveBeenCalled();
  });
});

describe('generateWithTools', () => {
  const tool = {
    name: 'record_proposal',
    description: 'Record one finding.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeCost.mockReturnValue(0.018);
    mockExceedsBudget.mockReturnValue({
      exceeded: false,
      observed: 0.018,
      cap: null,
      median: null,
    });
  });

  it('returns an empty array when the model calls no tool', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'nothing worth flagging' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toEqual([]);
  });

  it('returns one tool call when the model calls the tool once', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'Revenue dipped' } }],
      usage: { input_tokens: 200, output_tokens: 80 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toEqual([{ id: 'call_1', name: 'record_proposal', input: { title: 'Revenue dipped' } }]);
  });

  it('returns every tool call when the model calls the tool multiple times in one response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'First' } },
        { type: 'tool_use', id: 'call_2', name: 'record_proposal', input: { title: 'Second' } },
      ],
      usage: { input_tokens: 300, output_tokens: 120 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.input)).toEqual([{ title: 'First' }, { title: 'Second' }]);
  });

  it('ignores text blocks mixed alongside tool_use blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Here is what I found:' },
        { type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'Only this counts' } },
      ],
      usage: { input_tokens: 150, output_tokens: 60 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toEqual([{ id: 'call_1', name: 'record_proposal', input: { title: 'Only this counts' } }]);
  });

  it('logs a warning when the response was truncated at max_tokens', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'cut off' } }],
      usage: { input_tokens: 900, output_tokens: 1024 },
      stop_reason: 'max_tokens',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
      expect.stringContaining('truncated'),
    );
    expect(result).toEqual([]);
  });

  it('drops every tool call, not just the last one, when truncated at max_tokens', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'First' } },
        { type: 'tool_use', id: 'call_2', name: 'record_proposal', input: { title: 'cut off' } },
      ],
      usage: { input_tokens: 900, output_tokens: 1024 },
      stop_reason: 'max_tokens',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toEqual([]);
    expect(mockDropMetric.inc).toHaveBeenCalledWith({ caller: 'generateTool', reason: 'max_tokens' });
  });

  it('does not increment the drop metric when a max_tokens response had no tool calls to drop', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'cut off mid-sentence' }],
      usage: { input_tokens: 900, output_tokens: 1024 },
      stop_reason: 'max_tokens',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(result).toEqual([]);
    expect(mockDropMetric.inc).not.toHaveBeenCalled();
  });

  it('does not warn when the response completes normally', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'complete' } }],
      usage: { input_tokens: 200, output_tokens: 80 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sends tool_choice auto and translates ToolDefinition into the SDK Tool shape', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const { generateWithTools } = await import('./claudeClient.js');
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'auto' },
        tools: [
          {
            name: 'record_proposal',
            description: 'Record one finding.',
            input_schema: tool.inputSchema,
          },
        ],
      }),
    );
  });

  it('wraps API errors in ExternalServiceError', async () => {
    mockCreate.mockRejectedValue(new Error('connection timeout'));

    const { generateWithTools } = await import('./claudeClient.js');

    await expect(generateWithTools({ system: '', user: 'analyze' }, [tool])).rejects.toThrow(
      'External service error: Claude API',
    );
  });

  it('throws CostBudgetExceededError when tool-call cost exceeds budget', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'Expensive' } }],
      usage: { input_tokens: 100000, output_tokens: 100000 },
      stop_reason: 'tool_use',
    });
    mockComputeCost.mockReturnValue(2.0);
    mockExceedsBudget.mockReturnValue({
      exceeded: true,
      observed: 2.0,
      cap: 1.0,
      median: 0.05,
    });

    const { generateWithTools } = await import('./claudeClient.js');

    await expect(generateWithTools({ system: '', user: 'analyze' }, [tool])).rejects.toMatchObject({
      code: 'COST_BUDGET_EXCEEDED',
      statusCode: 503,
    });
    expect(mockBudgetMetric.inc).toHaveBeenCalledWith({ caller: 'generateTool' });
    expect(mockRecordCost).not.toHaveBeenCalled();
  });

  it('records cost into history on a successful call', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'ok' } }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(mockRecordCost).toHaveBeenCalledWith(0.018);
    expect(mockBudgetMetric.inc).not.toHaveBeenCalled();
  });

  it('skips the API call entirely when no tools are offered', async () => {
    const { generateWithTools } = await import('./claudeClient.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, []);

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('warns when the response ends for an unexpected reason other than max_tokens', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'unfinished' } }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'refusal',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'refusal' }),
      expect.stringContaining('unexpected reason'),
    );
    expect(result).toEqual([]);
    expect(mockDropMetric.inc).toHaveBeenCalledWith({ caller: 'generateTool', reason: 'abnormal_stop_reason' });
  });

  it('drops tool calls and warns when the response ends on stop_sequence', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'unfinished' } }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'stop_sequence',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    const result = await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'stop_sequence' }),
      expect.stringContaining('unexpected reason'),
    );
    expect(result).toEqual([]);
    expect(mockDropMetric.inc).toHaveBeenCalledWith({ caller: 'generateTool', reason: 'abnormal_stop_reason' });
  });

  it('logs when the response includes text alongside a tool call', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Here is what I found:' },
        { type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'Only this counts' } },
      ],
      usage: { input_tokens: 150, output_tokens: 60 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ textBlockCount: 1, toolCallCount: 1 }),
      expect.stringContaining('included text'),
    );
  });

  it('invokes the optional onCost callback with the computed cost on a successful call', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'ok' } }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const onCost = vi.fn();
    await generateWithTools({ system: '', user: 'analyze' }, [tool], onCost);

    expect(onCost).toHaveBeenCalledWith(0.018);
  });

  it('invokes onCost with null when computeCost cannot price the model', async () => {
    mockComputeCost.mockReturnValueOnce(null);
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'record_proposal', input: { title: 'ok' } }],
      usage: { input_tokens: 1000, output_tokens: 1000 },
      stop_reason: 'tool_use',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const onCost = vi.fn();
    await generateWithTools({ system: '', user: 'analyze' }, [tool], onCost);

    expect(onCost).toHaveBeenCalledWith(null);
  });

  it('never calls onCost when no tools are offered, since the API call is skipped entirely', async () => {
    const { generateWithTools } = await import('./claudeClient.js');
    const onCost = vi.fn();
    await generateWithTools({ system: '', user: 'analyze' }, [], onCost);

    expect(onCost).not.toHaveBeenCalled();
  });
});

describe('converseWithTools', () => {
  const tool = {
    name: 'get_metric_with_trend',
    description: 'Get one metric.',
    inputSchema: { type: 'object', properties: { statType: { type: 'string' } }, required: ['statType'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeCost.mockReturnValue(0.01);
    mockExceedsBudget.mockReturnValue({ exceeded: false, observed: 0.01, cap: null, median: null });
  });

  it('throws synchronously without calling the SDK when toolResults is empty and state is non-null', async () => {
    const { converseWithTools } = await import('./claudeClient.js');
    const priorState = [{ role: 'user', content: 'analyze' }];

    await expect(converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [])).rejects.toThrow(
      'toolResults must be non-empty once state is non-null',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('sends only the user question as the first turn, with tools and tool_choice auto', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } }],
      usage: { input_tokens: 200, output_tokens: 80 },
    });

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(null, { system: '', user: 'How is revenue trending?' }, [tool], []);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'How is revenue trending?' }],
        tools: [{ name: 'get_metric_with_trend', description: 'Get one metric.', input_schema: tool.inputSchema }],
        tool_choice: { type: 'auto' },
      }),
      { signal: undefined },
    );
  });

  it('returns ToolCalls with an id and the turn usage', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } }],
      usage: { input_tokens: 200, output_tokens: 80 },
      stop_reason: 'tool_use',
    });

    const { converseWithTools } = await import('./claudeClient.js');
    const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } }]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    expect(result.text).toBe('');
  });

  it('drops toolCalls but keeps text when a turn is truncated at max_tokens', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Revenue is up, checking the exact' },
        { type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } },
      ],
      usage: { input_tokens: 200, output_tokens: 1024 },
      stop_reason: 'max_tokens',
    });

    const { converseWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('Revenue is up, checking the exact');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
      expect.stringContaining('truncated at max_tokens'),
    );
    expect(mockDropMetric.inc).toHaveBeenCalledWith({ caller: 'converseWithTools', reason: 'max_tokens' });
  });

  it.each(['refusal', 'stop_sequence', 'pause_turn'])(
    'drops toolCalls but keeps text and usage when a turn ends on stop_reason %s',
    async (stopReason) => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Revenue is up, checking the exact' },
          { type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } },
        ],
        usage: { input_tokens: 200, output_tokens: 40 },
        stop_reason: stopReason,
      });

      const { converseWithTools } = await import('./claudeClient.js');
      const { logger } = await import('../../lib/logger.js');
      const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

      expect(result.toolCalls).toEqual([]);
      expect(result.text).toBe('Revenue is up, checking the exact');
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason }),
        'Claude API multi-turn tool conversation ended for an unexpected reason',
      );
      expect(mockDropMetric.inc).toHaveBeenCalledWith({ caller: 'converseWithTools', reason: 'abnormal_stop_reason' });
    },
  );

  it('does not increment the drop metric when an abnormal, non-max_tokens turn had no tool calls to drop', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'cut off mid-thought' }],
      usage: { input_tokens: 200, output_tokens: 40 },
      stop_reason: 'stop_sequence',
    });

    const { converseWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('cut off mid-thought');
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'stop_sequence' }),
      'Claude API multi-turn tool conversation ended for an unexpected reason',
    );
    expect(mockDropMetric.inc).not.toHaveBeenCalled();
  });

  it('joins text blocks into the turn text when the model answers instead of calling a tool', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Revenue is up 12% this quarter.' }],
      usage: { input_tokens: 150, output_tokens: 40 },
    });

    const { converseWithTools } = await import('./claudeClient.js');
    const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('Revenue is up 12% this quarter.');
  });

  it('threads a prior state and appends tool_result blocks keyed by toolCallId on a later turn', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Based on that, revenue is trending up.' }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });

    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
      { toolCallId: 'call_1', output: { value: 42 } },
    ]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          ...priorState,
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: JSON.stringify({ value: 42 }) }],
          },
        ],
      }),
      { signal: undefined },
    );
  });

  it('marks a rejected tool call is_error in the tool_result block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_bad', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
      { toolCallId: 'call_bad', output: { error: 'rejected' }, isError: true },
    ]);

    const body = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_bad', content: JSON.stringify({ error: 'rejected' }), is_error: true },
    ]);
  });

  describe('tool_result content sanitization', () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    async function sendToolResult(output: unknown) {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 50, output_tokens: 10 },
        stop_reason: 'end_turn',
      });

      const { converseWithTools } = await import('./claudeClient.js');
      await converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
        { toolCallId: 'call_1', output },
      ]);

      const body = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: Array<{ content: string }> }> };
      return body.messages[2]!.content[0]!.content;
    }

    it('leaves normal stat output unchanged', async () => {
      const output = { id: '3:trend:Sales:0', category: 'Retail', value: 120 };
      expect(await sendToolResult(output)).toBe(JSON.stringify(output));
    });

    it('preserves ZWJ and ZWNJ, the two legitimate joiners excluded from the strip', async () => {
      const content = await sendToolResult({ category: 'Retail\u200D\u200CSales' });
      expect(content).toBe(JSON.stringify({ category: 'Retail\u200D\u200CSales' }));
    });

    it('strips a Cc control character JSON.stringify does not escape', async () => {
      // JSON.stringify only escapes < 0x20; DEL (0x7F) passes through raw.
      const content = await sendToolResult({ category: 'Retail\u007fSales' });
      expect(content).toBe(JSON.stringify({ category: 'RetailSales' }));
    });

    it('strips a C1 control character', async () => {
      const content = await sendToolResult({ category: 'Retail\u0085Sales' });
      expect(content).toBe(JSON.stringify({ category: 'RetailSales' }));
    });

    it('strips a Unicode Tag-block character (ASCII-smuggling payload)', async () => {
      // Proves the strip covers all of \p{Cf}, not just a hand-picked list --
      // the Tag block isn't named anywhere in this file's source.
      const content = await sendToolResult({ category: 'Retail\u{E0001}Sales' });
      expect(content).toBe(JSON.stringify({ category: 'RetailSales' }));
    });

    it('strips bidi-override and zero-width characters from a category value', async () => {
      const content = await sendToolResult({ category: 'Retail\u202E\u200Bhidden' });
      expect(content).toBe(JSON.stringify({ category: 'Retailhidden' }));
    });

    it('strips line and paragraph separator characters', async () => {
      const content = await sendToolResult({ category: 'Retail\u2028Sales\u2029' });
      expect(content).toBe(JSON.stringify({ category: 'RetailSales' }));
    });

    it('truncates oversized output to the length cap with a trailing marker', async () => {
      const content = await sendToolResult({ category: 'x'.repeat(5000) });
      expect(content.length).toBeLessThanOrEqual(4000);
      expect(content.endsWith('... [truncated]')).toBe(true);
    });

    it('does not truncate content exactly at the cap', async () => {
      const wrapperLength = JSON.stringify({ category: '' }).length;
      const content = await sendToolResult({ category: 'x'.repeat(4000 - wrapperLength) });
      expect(content.length).toBe(4000);
      expect(content.endsWith('[truncated]')).toBe(false);
    });

    it('truncates content one character over the cap', async () => {
      const wrapperLength = JSON.stringify({ category: '' }).length;
      const content = await sendToolResult({ category: 'x'.repeat(4000 - wrapperLength + 1) });
      expect(content.length).toBe(4000);
      expect(content.endsWith('... [truncated]')).toBe(true);
    });

    it('does not split a surrogate pair at the truncation boundary', async () => {
      // Sweeps a window of cut positions around the cap so the emoji's
      // surrogate pair lands exactly on the boundary at least once,
      // without hand-deriving the marker length's exact offset.
      const wrapperLength = JSON.stringify({ category: '' }).length;
      const prefixLength = wrapperLength - 2; // length of `{"category":"`
      const approxCutOffsetInCategory = 4000 - '... [truncated]'.length - prefixLength;
      const emoji = '\u{1F600}'; // 2 UTF-16 code units

      for (let offset = -5; offset <= 5; offset++) {
        const leadingX = Math.max(0, approxCutOffsetInCategory + offset);
        const content = await sendToolResult({ category: 'x'.repeat(leadingX) + emoji + 'x'.repeat(50) });
        expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
    });

    it('leaves a null output as the literal string "null"', async () => {
      expect(await sendToolResult(null)).toBe('null');
    });

    it('leaves an undefined output on the String(output) fallback path', async () => {
      expect(await sendToolResult(undefined)).toBe('undefined');
    });

    it('warns with a removed-character count when content is stripped', async () => {
      await sendToolResult({ category: 'Retail\u202EHidden' });

      expect(logger.warn).toHaveBeenCalledWith(
        { removedCount: 1 },
        'Tool result content had unsafe code points stripped before re-entering the conversation',
      );
    });

    it('warns with the pre-truncation length and cap when content is truncated', async () => {
      await sendToolResult({ category: 'x'.repeat(5000) });

      expect(logger.warn).toHaveBeenCalledWith(
        { preTruncationLength: JSON.stringify({ category: 'x'.repeat(5000) }).length, cap: 4000 },
        'Tool result content exceeded the length cap and was truncated before re-entering the conversation',
      );
    });

    it('does not warn when content needs no stripping or truncation', async () => {
      await sendToolResult({ category: 'Retail', value: 120 });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns on both the stripping and truncation paths when a single tool result needs both', async () => {
      const output = { category: 'Retail\u202E' + 'x'.repeat(5000) };
      const stripped = JSON.stringify(output).replaceAll('\u202E', '');
      await sendToolResult(output);

      expect(logger.warn).toHaveBeenCalledWith(
        { removedCount: JSON.stringify(output).length - stripped.length },
        'Tool result content had unsafe code points stripped before re-entering the conversation',
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { preTruncationLength: stripped.length, cap: 4000 },
        'Tool result content exceeded the length cap and was truncated before re-entering the conversation',
      );
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects a non-array state without calling the SDK', async () => {
    const { converseWithTools } = await import('./claudeClient.js');

    await expect(
      converseWithTools('opaque-string', { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state must be the message array returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an undefined state without calling the SDK', async () => {
    const { converseWithTools } = await import('./claudeClient.js');

    await expect(
      converseWithTools(undefined, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state must be the message array returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a state array whose elements are not message-shaped without calling the SDK', async () => {
    const { converseWithTools } = await import('./claudeClient.js');

    await expect(
      converseWithTools([1, 2, 3], { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state does not match the message shape returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an empty array state without calling the SDK', async () => {
    const { converseWithTools } = await import('./claudeClient.js');

    await expect(
      converseWithTools([], { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state does not match the message shape returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a state message with an invalid role without calling the SDK', async () => {
    const priorState = [{ role: 'system', content: 'analyze' }];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state does not match the message shape returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a state message with a malformed content block without calling the SDK', async () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [null] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state does not match the message shape returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a state message with an empty content array without calling the SDK', async () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('state does not match the message shape returned by a prior turn');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects any toolCallId when the prior turn left no tool_use blocks pending', async () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_1', output: {} }]),
    ).rejects.toThrow('does not match a pending tool_use id');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a duplicate toolCallId without calling the SDK', async () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
        { toolCallId: 'call_1', output: { value: 1 } },
        { toolCallId: 'call_1', output: { value: 2 } },
      ]),
    ).rejects.toThrow('duplicate toolCallId');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a toolCallId that does not match a pending tool_use id without calling the SDK', async () => {
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await expect(
      converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [{ toolCallId: 'call_9', output: {} }]),
    ).rejects.toThrow('does not match a pending tool_use id');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows toolResults to answer only a subset of the pending tool_use ids', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const priorState = [
      { role: 'user', content: 'analyze' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'get_metric_with_trend', input: {} },
        ],
      },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
      { toolCallId: 'call_1', output: { value: 1 } },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('omits tools and tool_choice from the request when tools is empty, forcing a text-only turn', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(null, { system: '', user: 'analyze' }, [], []);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const body = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('appends the final-turn notice to the tool_result message on a forced final turn', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(priorState, { system: '', user: 'analyze' }, [], [
      { toolCallId: 'call_1', output: { value: 42 } },
    ]);

    const body = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: JSON.stringify({ value: 42 }) },
      { type: 'text', text: 'No further tool calls are available. Answer now using only what has already been gathered.' },
    ]);
  });

  it('does not append the final-turn notice when tools is non-empty', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const priorState = [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_metric_with_trend', input: {} }] },
    ];

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(priorState, { system: '', user: 'analyze' }, [tool], [
      { toolCallId: 'call_1', output: { value: 42 } },
    ]);

    const body = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: JSON.stringify({ value: 42 }) },
    ]);
  });

  it('does not append the final-turn notice on the first turn even when tools is empty', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(null, { system: '', user: 'analyze' }, [], []);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'analyze' }] }),
      { signal: undefined },
    );
  });

  it('throws CostBudgetExceededError when a turn costs more than the budget', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'expensive' }],
      usage: { input_tokens: 100000, output_tokens: 100000 },
    });
    mockComputeCost.mockReturnValue(2.0);
    mockExceedsBudget.mockReturnValue({ exceeded: true, observed: 2.0, cap: 1.0, median: 0.05 });

    const { converseWithTools } = await import('./claudeClient.js');

    await expect(converseWithTools(null, { system: '', user: 'analyze' }, [tool], [])).rejects.toMatchObject({
      code: 'COST_BUDGET_EXCEEDED',
      statusCode: 503,
    });
    expect(mockBudgetMetric.inc).toHaveBeenCalledWith({ caller: 'converseWithTools' });
  });

  it('passes the abort signal to the SDK call', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const controller = new AbortController();

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools(null, { system: '', user: 'analyze' }, [], [], controller.signal);

    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it('throws an aborted-by-client error when the signal is aborted and the call rejects', async () => {
    const controller = new AbortController();
    controller.abort();
    mockCreate.mockRejectedValue(new Error('fetch aborted'));

    const { converseWithTools } = await import('./claudeClient.js');

    await expect(
      converseWithTools(null, { system: '', user: 'analyze' }, [tool], [], controller.signal),
    ).rejects.toThrow('aborted by client');
  });

  it('wraps a genuine provider error in ExternalServiceError', async () => {
    mockCreate.mockRejectedValue(new Error('connection timeout'));

    const { converseWithTools } = await import('./claudeClient.js');

    await expect(converseWithTools(null, { system: '', user: 'analyze' }, [tool], [])).rejects.toThrow(
      'External service error: Claude API',
    );
  });
});
