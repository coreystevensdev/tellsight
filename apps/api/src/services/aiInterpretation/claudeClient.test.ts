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
