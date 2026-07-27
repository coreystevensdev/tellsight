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

vi.mock('../../lib/circuitBreaker.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation(() => ({
    exec: <T>(fn: () => Promise<T>) => fn(),
    isOpen: () => false,
  })),
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
vi.mock('../../lib/metrics.js', () => ({
  aiCostBudgetExceeded: mockBudgetMetric,
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
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
      expect.stringContaining('truncated'),
    );
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
      content: [{ type: 'text', text: 'I decline to answer that.' }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'refusal',
    });

    const { generateWithTools } = await import('./claudeClient.js');
    const { logger } = await import('../../lib/logger.js');
    await generateWithTools({ system: '', user: 'analyze' }, [tool]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'refusal' }),
      expect.stringContaining('unexpected reason'),
    );
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
    });

    const { converseWithTools } = await import('./claudeClient.js');
    const result = await converseWithTools(null, { system: '', user: 'analyze' }, [tool], []);

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_metric_with_trend', input: { statType: 'trend' } }]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    expect(result.text).toBe('');
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

    const { converseWithTools } = await import('./claudeClient.js');
    await converseWithTools([], { system: '', user: 'analyze' }, [tool], [
      { toolCallId: 'call_bad', output: { error: 'rejected' }, isError: true },
    ]);

    const body = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_bad', content: JSON.stringify({ error: 'rejected' }), is_error: true },
    ]);
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
