import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import type { StreamResult } from './claudeClient.js';

vi.mock('../../config.js', () => ({
  env: {
    CLAUDE_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRunCurationPipeline = vi.fn();
const mockAssemblePrompt = vi.fn();
const mockValidateSummary = vi.fn();
vi.mock('../curation/index.js', () => ({
  runCurationPipeline: (...args: unknown[]) => mockRunCurationPipeline(...args),
  assemblePrompt: (...args: unknown[]) => mockAssemblePrompt(...args),
  validateSummary: (...args: unknown[]) => mockValidateSummary(...args),
  transparencyMetadataSchema: { parse: (v: unknown) => v },
}));

const mockStreamInterpretation = vi.fn();
vi.mock('./claudeClient.js', () => ({
  streamInterpretation: (...args: unknown[]) => mockStreamInterpretation(...args),
}));

const mockStoreSummary = vi.fn();
vi.mock('../../db/queries/index.js', () => ({
  aiSummariesQueries: {
    storeSummary: (...args: unknown[]) => mockStoreSummary(...args),
  },
}));

const mockTrackEvent = vi.fn();
vi.mock('../analytics/trackEvent.js', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

// mock Anthropic SDK error classes for instanceof checks
vi.mock('@anthropic-ai/sdk', () => {
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}

  return {
    default: {
      AuthenticationError: class AuthenticationError extends Error {},
      BadRequestError: class BadRequestError extends Error {},
      RateLimitError: class RateLimitError extends Error {},
      InternalServerError: class InternalServerError extends Error {},
      APIConnectionError,
      APIConnectionTimeoutError,
    },
  };
});

function createMockRes() {
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  return {
    chunks,
    headers,
    res: {
      setHeader: vi.fn((k: string, v: string) => headers.set(k, v)),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => chunks.push(chunk)),
      end: vi.fn(),
    } as unknown as Response,
  };
}

function createMockReq() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    triggerClose: () => {
      for (const cb of listeners.get('close') ?? []) cb();
    },
  } as unknown as Request & { triggerClose: () => void };
}

const defaultMetadata = {
  statTypes: ['total'],
  categoryCount: 1,
  insightCount: 1,
  scoringWeights: { novelty: 0.4, actionability: 0.4, specificity: 0.2 },
  promptVersion: 'v1',
  generatedAt: '2026-01-01T00:00:00Z',
};

describe('streamToSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockRunCurationPipeline.mockResolvedValue([]);
    mockAssemblePrompt.mockReturnValue({
      prompt: 'test prompt',
      metadata: defaultMetadata,
    });
    mockValidateSummary.mockReturnValue({
      status: 'clean',
      unmatchedNumbers: [],
      numbersChecked: 0,
      allowedValueCount: 0,
    });
    mockStoreSummary.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets SSE headers and flushes', async () => {
    const streamResult: StreamResult = {
      fullText: 'Analysis done.',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('Analysis done.');
        return streamResult;
      },
    );

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it('streams text events and sends done', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('Hello ');
        onText('world');
        return {
          fullText: 'Hello world',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    expect(chunks).toContain('event: text\ndata: {"text":"Hello "}\n\n');
    expect(chunks).toContain('event: text\ndata: {"text":"world"}\n\n');

    const doneChunk = chunks.find((c) => c.startsWith('event: done'));
    expect(doneChunk).toBeDefined();
    expect(res.end).toHaveBeenCalled();
  });

  it('caches the full response after streaming', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('cached text');
        return {
          fullText: 'cached text',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 42, 99);

    expect(mockStoreSummary).toHaveBeenCalledWith(1, 42, 'cached text', defaultMetadata, 'v1', false, undefined);
  });

  it('emits AI_SUMMARY_VALIDATION_FLAGGED when the validator finds unmatched numbers', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('summary with fabricated numbers');
        return {
          fullText: 'summary with fabricated numbers',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );
    mockValidateSummary.mockReturnValue({
      status: 'suspicious',
      numbersChecked: 5,
      allowedValueCount: 12,
      unmatchedNumbers: [
        { raw: '$87,000', value: 87000, kind: 'currency', context: 'Q3 revenue was $87,000' },
        { raw: '42%', value: 42, kind: 'percent', context: 'margin hit 42%' },
      ],
    });

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 42, 99, 'pro');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      1,
      99,
      'ai.summary_validation_flagged',
      expect.objectContaining({
        datasetId: 42,
        tier: 'pro',
        promptVersion: 'v1',
        status: 'suspicious',
        numbersChecked: 5,
        unmatchedCount: 2,
      }),
    );
  });

  it('does not emit the validation event when the validator returns clean', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('clean summary');
        return {
          fullText: 'clean summary',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );
    // default beforeEach already returns clean — reassert for clarity
    mockValidateSummary.mockReturnValue({
      status: 'clean',
      numbersChecked: 3,
      allowedValueCount: 8,
      unmatchedNumbers: [],
    });

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('sends error event on stream failure', async () => {
    mockStreamInterpretation.mockRejectedValue(new Error('API blew up'));

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('STREAM_ERROR');
    expect(errorChunk).toContain('"retryable":true');
    expect(res.end).toHaveBeenCalled();
  });

  it('sends partial event on timeout when text was already streamed', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void, signal?: AbortSignal) => {
        onText('Some partial ');
        onText('content here');
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(req, res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(15_000);
    await promise;

    const partialChunk = chunks.find((c) => c.startsWith('event: partial'));
    expect(partialChunk).toBeDefined();
    expect(partialChunk).toContain('Some partial content here');
    // metadata should be included so TransparencyPanel works in timeout state
    expect(partialChunk).toContain('"metadata"');
    expect(partialChunk).toContain('"promptVersion"');

    const doneChunk = chunks.find((c) => c.startsWith('event: done'));
    expect(doneChunk).toBeDefined();
    expect(doneChunk).toContain('"usage":null');
    expect(doneChunk).toContain('"reason":"timeout"');
    expect(res.end).toHaveBeenCalled();
  });

  it('sends TIMEOUT error on timeout with no text received', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, _onText: (d: string) => void, signal?: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(req, res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(15_000);
    await promise;

    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('"code":"TIMEOUT"');
    expect(errorChunk).toContain('"retryable":true');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not cache partial results on timeout', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void, signal?: AbortSignal) => {
        onText('partial');
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(req, res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(15_000);
    await promise;

    expect(mockStoreSummary).not.toHaveBeenCalled();
  });

  it('handles client disconnect gracefully', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, _cb: (d: string) => void, signal?: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { res } = createMockRes();
    const req = createMockReq() as Request & { triggerClose: () => void };

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(req, res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(100);
    req.triggerClose();

    await promise;

    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: error'));
  });

  it('sends PIPELINE_ERROR when curation pipeline fails', async () => {
    mockRunCurationPipeline.mockRejectedValue(new Error('bad data shape'));

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('"code":"PIPELINE_ERROR"');
    expect(errorChunk).toContain('"retryable":true');
    expect(errorChunk).toContain('Something went wrong preparing your analysis');
    expect(mockStreamInterpretation).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('sends EMPTY_RESPONSE when Claude returns no text', async () => {
    mockStreamInterpretation.mockImplementation(
      async () => ({
        fullText: '',
        usage: { inputTokens: 100, outputTokens: 0 },
      }),
    );

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('"code":"EMPTY_RESPONSE"');
    expect(errorChunk).toContain('"retryable":true');
    expect(mockStoreSummary).not.toHaveBeenCalled();
  });

  describe('error type mapping', () => {
    it.each([
      ['AuthenticationError', 'AI_AUTH_ERROR', false],
      ['RateLimitError', 'RATE_LIMITED', false],
      ['BadRequestError', 'STREAM_ERROR', false],
      ['InternalServerError', 'AI_UNAVAILABLE', true],
      ['APIConnectionError', 'AI_UNAVAILABLE', true],
      ['APIConnectionTimeoutError', 'TIMEOUT', true],
    ] as const)('maps %s to %s (retryable=%s)', async (errorClass, expectedCode, expectedRetryable) => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const ErrorClass = Anthropic[errorClass] as new (msg: string) => Error;
      mockStreamInterpretation.mockRejectedValue(new ErrorClass('test'));

      const { res, chunks } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(req, res, 1, 1, 99);

      const errorChunk = chunks.find((c) => c.startsWith('event: error'));
      expect(errorChunk).toContain(`"code":"${expectedCode}"`);
      expect(errorChunk).toContain(`"retryable":${expectedRetryable}`);
    });
  });

  it('flushes headers before pipeline runs — all errors are SSE-delivered', async () => {
    const callOrder: string[] = [];
    mockRunCurationPipeline.mockImplementation(async () => {
      callOrder.push('pipeline');
      throw new Error('pipeline boom');
    });

    const { res, chunks } = createMockRes();
    (res.flushHeaders as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('flushHeaders');
    });
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    expect(callOrder).toEqual(['flushHeaders', 'pipeline']);
    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toContain('"code":"PIPELINE_ERROR"');
  });

  it('logs warning but does not throw when storeSummary fails', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('good text');
        return {
          fullText: 'good text',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );
    mockStoreSummary.mockRejectedValue(new Error('DB constraint violation'));

    const { res, chunks } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    const result = await streamToSSE(req, res, 1, 1, 99);

    // stream was delivered successfully
    const doneChunk = chunks.find((c) => c.startsWith('event: done'));
    expect(doneChunk).toBeDefined();
    expect(result.ok).toBe(true);

    // verify warning was logged, not an unhandled rejection
    const { logger } = await import('../../lib/logger.js');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'DB constraint violation' }),
      'failed to cache AI summary — stream already delivered',
    );
  });

  it('calls res.end only once on double-end race', async () => {
    // stream completes just before timeout fires
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('full text');
        return {
          fullText: 'full text',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );

    const { res } = createMockRes();
    const req = createMockReq();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(req, res, 1, 1, 99);

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  describe('free-tier truncation', () => {
    function generateWords(count: number): string {
      return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
    }

    it('truncates at ~150 words and sends upgrade_required for free tier', async () => {
      const longText = generateWords(200);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void) => {
          onText(longText);
          // abort fires synchronously inside onText — just throw
          throw new Error('aborted');
        },
      );

      const { res, chunks } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      const result = await streamToSSE(req, res, 1, 1, 99, 'free');

      const upgradeChunk = chunks.find((c) => c.startsWith('event: upgrade_required'));
      expect(upgradeChunk).toBeDefined();
      expect(upgradeChunk).toContain('"wordCount"');

      const doneChunk = chunks.find((c) => c.startsWith('event: done'));
      expect(doneChunk).toBeDefined();
      expect(doneChunk).toContain('"reason":"free_preview"');

      expect(res.end).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('streams fully for pro tier', async () => {
      const longText = generateWords(200);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void) => {
          onText(longText);
          return {
            fullText: longText,
            usage: { inputTokens: 100, outputTokens: 200 },
          };
        },
      );

      const { res, chunks } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(req, res, 1, 1, 99, 'pro');

      const upgradeChunk = chunks.find((c) => c.startsWith('event: upgrade_required'));
      expect(upgradeChunk).toBeUndefined();

      const doneChunk = chunks.find((c) => c.startsWith('event: done'));
      expect(doneChunk).toBeDefined();
    });

    it('does not truncate if word count is under limit', async () => {
      const shortText = generateWords(40);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void) => {
          onText(shortText);
          return {
            fullText: shortText,
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      );

      const { res, chunks } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(req, res, 1, 1, 99, 'free');

      const upgradeChunk = chunks.find((c) => c.startsWith('event: upgrade_required'));
      expect(upgradeChunk).toBeUndefined();
    });

    it('timeout takes precedence over truncation when it fires first', async () => {
      // stream under the word limit then stall until timeout
      const shortText = generateWords(30);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void, signal?: AbortSignal) => {
          onText(shortText);
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      );

      const { res, chunks } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      const promise = streamToSSE(req, res, 1, 1, 99, 'free');

      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      // timeout should produce partial, not upgrade_required
      const upgradeChunk = chunks.find((c) => c.startsWith('event: upgrade_required'));
      expect(upgradeChunk).toBeUndefined();

      const partialChunk = chunks.find((c) => c.startsWith('event: partial'));
      expect(partialChunk).toBeDefined();
    });

    it('aborts Claude stream after truncation to save tokens', async () => {
      let abortSignal: AbortSignal | undefined;
      const longText = generateWords(200);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void, signal?: AbortSignal) => {
          abortSignal = signal;
          onText(longText);
          // abort fires synchronously inside onText — just throw
          throw new Error('aborted');
        },
      );

      const { res } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(req, res, 1, 1, 99, 'free');

      expect(abortSignal?.aborted).toBe(true);
    });

    it('does not cache truncated free-tier summaries', async () => {
      const longText = generateWords(200);
      mockStreamInterpretation.mockImplementation(
        async (_prompt: string, onText: (d: string) => void) => {
          onText(longText);
          throw new Error('aborted');
        },
      );

      const { res } = createMockRes();
      const req = createMockReq();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(req, res, 1, 1, 99, 'free');

      expect(mockStoreSummary).not.toHaveBeenCalled();
    });
  });
});
