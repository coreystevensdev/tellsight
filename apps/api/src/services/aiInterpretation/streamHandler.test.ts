import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One test here stands up a real HTTP server and aborts a real client socket,
// because res.destroyed and res.writableEnded cannot be observed through a
// mock. It times out at the 5000ms default under parallel load, which matters
// now that this job can fail the build rather than being continue-on-error.
vi.setConfig({ testTimeout: 30_000 });
import type { Response } from 'express';
import type { StreamResult } from './claudeClient.js';
import type { StreamOutcome } from './streamHandler.js';

vi.mock('../../config.js', () => ({
  env: {
    CLAUDE_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const mockRunCurationPipeline = vi.fn();
const mockAssemblePrompt = vi.fn();
const mockValidateSummary = vi.fn();
const mockValidateStatRefs = vi.fn((..._args: unknown[]) => ({ invalidRefs: [] as string[] }));
const mockStripInvalidStatRefs = vi.fn((...args: unknown[]) => String(args[0] ?? ''));
const mockValidateCiteRefs = vi.fn((..._args: unknown[]) => ({ invalidRefs: [] as string[] }));
const mockStripInvalidCiteRefs = vi.fn((...args: unknown[]) => String(args[0] ?? ''));
vi.mock('../curation/index.js', () => ({
  runCurationPipeline: (...args: unknown[]) => mockRunCurationPipeline(...args),
  assemblePrompt: (...args: unknown[]) => mockAssemblePrompt(...args),
  validateSummary: (...args: unknown[]) => mockValidateSummary(...args),
  validateStatRefs: (...args: unknown[]) => mockValidateStatRefs(...args),
  stripInvalidStatRefs: (...args: unknown[]) => mockStripInvalidStatRefs(...args),
  validateCiteRefs: (...args: unknown[]) => mockValidateCiteRefs(...args),
  stripInvalidCiteRefs: (...args: unknown[]) => mockStripInvalidCiteRefs(...args),
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
  const listeners = new Map<string, (() => void)[]>();
  const res = {
    writableEnded: false,
    destroyed: false,
    setHeader: vi.fn((k: string, v: string) => headers.set(k, v)),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => chunks.push(chunk)),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    triggerClose: () => {
      for (const cb of listeners.get('close') ?? []) cb();
    },
  };
  return { chunks, headers, res: res as unknown as Response & { triggerClose: () => void } };
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
    // Shape has to match what assemblePrompt actually returns. It was
    // { prompt, metadata } here while production destructures
    // { system, user, metadata }, so every test in this file ran with
    // promptInput = { system: undefined, user: undefined } and the main AI
    // path had no prompt coverage at all.
    mockAssemblePrompt.mockReturnValue({
      system: 'test system prompt',
      user: 'test user prompt',
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

  // Nothing asserted what streamInterpretation was handed, so the prompt could
  // have arrived empty and every test still passed. It did arrive empty, for as
  // long as the mock above returned the wrong shape.
  it('hands the assembled system and user prompt to the model', async () => {
    // Once, not mockImplementation. The suite's beforeEach uses clearAllMocks,
    // which resets calls but leaves implementations in place, so a persistent
    // one set here bleeds into every later test in the file.
    mockStreamInterpretation.mockImplementationOnce(
      async (_prompt: unknown, onText: (d: string) => void) => {
        onText('ok');
        return { fullText: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    );

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

    expect(mockStreamInterpretation).toHaveBeenCalled();
    const [promptInput] = mockStreamInterpretation.mock.calls[0]!;
    expect(promptInput).toEqual({
      system: 'test system prompt',
      user: 'test user prompt',
    });
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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99);

    expect(mockStoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 1,
        datasetId: 42,
        content: 'cached text',
        metadata: defaultMetadata,
        promptVersion: 'v1',
      }),
    );
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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

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

  it('emits ai.summary_directive_language_flagged when the summary contains banned directive language', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('Margins slipped. You need to cut payroll next month.');
        return {
          fullText: 'Margins slipped. You need to cut payroll next month.',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      1,
      99,
      'ai.summary_directive_language_flagged',
      expect.objectContaining({
        datasetId: 42,
        tier: 'pro',
        promptVersion: 'v1',
        phrases: ['You need to'],
      }),
    );
    // still delivered and cached, this check flags, it never blocks
    expect(mockStoreSummary).toHaveBeenCalled();
  });

  it('does not emit ai.summary_directive_language_flagged for advisory phrasing', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('Margins slipped, worth investigating with your accountant.');
        return {
          fullText: 'Margins slipped, worth investigating with your accountant.',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      1,
      99,
      'ai.summary_directive_language_flagged',
      expect.anything(),
    );
  });

  it('strips invalid stat-refs before cache write and emits ai.chart_ref_invalid', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('runway ');
        onText('<stat id="ghost"/>');
        onText(' ok');
        return {
          fullText: 'runway <stat id="ghost"/> ok',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );
    mockValidateStatRefs.mockReturnValueOnce({ invalidRefs: ['ghost'] });
    mockStripInvalidStatRefs.mockImplementationOnce((...args: unknown[]) => {
      const raw = String(args[0] ?? '');
      const invalid = (args[1] as string[] | undefined) ?? [];
      return raw.replace(/<stat\s+id="(\w+)"\s*\/>/g, (full, id) =>
        invalid.includes(id) ? '' : full,
      );
    });
    mockValidateSummary.mockReturnValueOnce({
      status: 'clean',
      numbersChecked: 0,
      allowedValueCount: 0,
      unmatchedNumbers: [],
    });

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    // analytics event fires with the hallucinated id
    expect(mockTrackEvent).toHaveBeenCalledWith(
      1,
      99,
      'ai.chart_ref_invalid',
      expect.objectContaining({
        datasetId: 42,
        tier: 'pro',
        invalidRefs: ['ghost'],
      }),
    );

    // the cache write received the stripped text, not the raw LLM output
    expect(mockStoreSummary).toHaveBeenCalled();
    const call = mockStoreSummary.mock.calls[0]!;
    expect(call[0]).toMatchObject({ orgId: 1, datasetId: 42, content: 'runway  ok' });
  });

  it('strips invalid cite-refs before cache write and emits ai.cite_ref_invalid', async () => {
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('runway ');
        onText('<cite id="ghost"/>');
        onText(' ok');
        return {
          fullText: 'runway <cite id="ghost"/> ok',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    );
    mockValidateCiteRefs.mockReturnValueOnce({ invalidRefs: ['ghost'] });
    mockStripInvalidCiteRefs.mockImplementationOnce((...args: unknown[]) => {
      const raw = String(args[0] ?? '');
      const invalid = (args[1] as string[] | undefined) ?? [];
      return raw.replace(/<cite\s+id="([^"]+)"\s*\/>/g, (full, id) =>
        invalid.includes(id) ? '' : full,
      );
    });
    mockValidateSummary.mockReturnValueOnce({
      status: 'clean',
      numbersChecked: 0,
      allowedValueCount: 0,
      unmatchedNumbers: [],
    });

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      1,
      99,
      'ai.cite_ref_invalid',
      expect.objectContaining({
        datasetId: 42,
        tier: 'pro',
        invalidRefs: ['ghost'],
      }),
    );

    expect(mockStoreSummary).toHaveBeenCalled();
    const call = mockStoreSummary.mock.calls[0]!;
    expect(call[0]).toMatchObject({ orgId: 1, datasetId: 42, content: 'runway  ok' });
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
    // default beforeEach already returns clean, reassert for clarity
    mockValidateSummary.mockReturnValue({
      status: 'clean',
      numbersChecked: 3,
      allowedValueCount: 8,
      unmatchedNumbers: [],
    });

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('sends error event on stream failure', async () => {
    mockStreamInterpretation.mockRejectedValue(new Error('API blew up'));

    const { res, chunks } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(15_000);
    await promise;

    expect(mockStoreSummary).not.toHaveBeenCalled();
  });

  it('handles client disconnect gracefully', async () => {
    let abortSignal: AbortSignal | undefined;
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, _cb: (d: string) => void, signal?: AbortSignal) => {
        abortSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { res } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    const promise = streamToSSE(res, 1, 1, 99);

    await vi.advanceTimersByTimeAsync(100);
    res.triggerClose();

    await promise;

    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: error'));
    expect(abortSignal?.aborted).toBe(true);
  });

  it('does not treat res.on(close) firing after normal completion as a disconnect', async () => {
    // simulates the real-world race: a 'close' event can land shortly after res.end()
    // (called inside onText's truncation branch) even on a successful delivery, not
    // because the client left. Without the res.writableEnded guard, this would flip
    // clientDisconnected to true and the free-tier success below would incorrectly
    // report { ok: false }.
    const longText = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const { res, chunks } = createMockRes();
    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText(longText);
        res.triggerClose();
        throw new Error('aborted');
      },
    );

    const { streamToSSE } = await import('./streamHandler.js');
    const result = await streamToSSE(res, 1, 1, 99, 'free');

    expect(result.ok).toBe(true);
    const doneChunk = chunks.find((c) => c.startsWith('event: done'));
    expect(doneChunk).toContain('"reason":"free_preview"');
  });

  it('bails out immediately when res is already destroyed before streaming starts', async () => {
    const { res } = createMockRes();
    res.destroyed = true;

    const { streamToSSE } = await import('./streamHandler.js');
    const result = await streamToSSE(res, 1, 1, 99);

    expect(result).toEqual({ ok: false, clientDisconnected: true });
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('sends PIPELINE_ERROR when curation pipeline fails', async () => {
    mockRunCurationPipeline.mockRejectedValue(new Error('bad data shape'));

    const { res, chunks } = createMockRes();

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

    const errorChunk = chunks.find((c) => c.startsWith('event: error'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('"code":"PIPELINE_ERROR"');
    expect(errorChunk).toContain('"retryable":true');
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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(res, 1, 1, 99);

      const errorChunk = chunks.find((c) => c.startsWith('event: error'));
      expect(errorChunk).toContain(`"code":"${expectedCode}"`);
      expect(errorChunk).toContain(`"retryable":${expectedRetryable}`);
    });
  });

  it('flushes headers before pipeline runs, all errors are SSE-delivered', async () => {
    const callOrder: string[] = [];
    mockRunCurationPipeline.mockImplementation(async () => {
      callOrder.push('pipeline');
      throw new Error('pipeline boom');
    });

    const { res, chunks } = createMockRes();
    (res.flushHeaders as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('flushHeaders');
    });

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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

    const { streamToSSE } = await import('./streamHandler.js');
    const result = await streamToSSE(res, 1, 1, 99);

    // stream was delivered successfully
    const doneChunk = chunks.find((c) => c.startsWith('event: done'));
    expect(doneChunk).toBeDefined();
    expect(result.ok).toBe(true);

    // verify warning was logged, not an unhandled rejection
    const { logger } = await import('../../lib/logger.js');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'DB constraint violation' }),
      'failed to cache AI summary, stream already delivered',
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

    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 1, 99);

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
          // abort fires synchronously inside onText, just throw
          throw new Error('aborted');
        },
      );

      const { res, chunks } = createMockRes();

      const { streamToSSE } = await import('./streamHandler.js');
      const result = await streamToSSE(res, 1, 1, 99, 'free');

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

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(res, 1, 1, 99, 'pro');

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

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(res, 1, 1, 99, 'free');

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

      const { streamToSSE } = await import('./streamHandler.js');
      const promise = streamToSSE(res, 1, 1, 99, 'free');

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
          // abort fires synchronously inside onText, just throw
          throw new Error('aborted');
        },
      );

      const { res } = createMockRes();

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(res, 1, 1, 99, 'free');

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

      const { streamToSSE } = await import('./streamHandler.js');
      await streamToSSE(res, 1, 1, 99, 'free');

      expect(mockStoreSummary).not.toHaveBeenCalled();
    });
  });
});

// Real http.Server + real Response, not createMockRes(). Proves the
// res.destroyed/writableEnded timing claim streamToSSE's early-return
// guard relies on. Needs real timers, so this is a sibling describe
// rather than nested under streamToSSE's fake-timer beforeEach.
describe('streamToSSE disconnect timing against a real server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sees res.destroyed true and res.writableEnded false after a real client abort', async () => {
    const { createTestApp } = await import('../../test/helpers/testApp.js');
    const { streamToSSE } = await import('./streamHandler.js');

    let captured:
      | { destroyed: boolean; writableEnded: boolean; outcome: StreamOutcome }
      | undefined;

    const { server, baseUrl } = await createTestApp((app) => {
      app.get('/stream-test', async (_req, res) => {
        // mirrors aiSummary.ts's rate-limit wait: register close before the
        // async gate so a disconnect during that gate isn't missed, leaving
        // res.destroyed as the only signal left for streamToSSE to check.
        await new Promise<void>((resolve) => res.once('close', resolve));

        const outcome = await streamToSSE(res, 1, 1, 99);
        captured = { destroyed: res.destroyed, writableEnded: res.writableEnded, outcome };
      });
    });

    try {
      const controller = new AbortController();
      const requestFailed = fetch(`${baseUrl}/stream-test`, { signal: controller.signal }).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await requestFailed;

      await vi.waitFor(() => expect(captured).toBeDefined());

      expect(captured?.destroyed).toBe(true);
      expect(captured?.writableEnded).toBe(false);
      expect(captured?.outcome).toEqual({ ok: false, clientDisconnected: true });
      expect(mockRunCurationPipeline).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// NFR2 and NFR3 have no CI-measurable assertion, because the runner streams
// against a dummy Claude key. Production observability is the only place those
// thresholds can be checked, so these guard that the metric still records at
// all rather than checking a wall-clock number.
describe('AI latency instrumentation (NFR2, NFR3)', () => {
  // Sibling of describe('streamToSSE'), so it never received that block's
  // beforeEach. It passed anyway because clearAllMocks resets calls and leaves
  // implementations, so whatever the last test up there configured was still in
  // place. Run this describe on its own and both tests failed with
  // "expected +0 to be 1": assemblePrompt returned undefined, the destructure in
  // streamHandler threw, the PIPELINE_ERROR branch ran, and no metric was ever
  // observed. The tests did catch a removed .observe(), but only by accident of
  // file ordering.
  //
  // Real timers deliberately: this measures latency, and the sibling block runs
  // on fake ones.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockRunCurationPipeline.mockResolvedValue([]);
    mockAssemblePrompt.mockReturnValue({
      system: 'test system prompt',
      user: 'test user prompt',
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

  // prom-client reports a histogram under its base name; the _count and _sum
  // samples live inside values[] under metricName, not as separate metrics.
  async function observationCount(metric: string, labels: Record<string, string>) {
    const { registry } = await import('../../lib/metrics.js');
    const json = await registry.getMetricsAsJSON();
    const found = json.find((m) => m.name === metric);
    if (!found) return 0;
    const samples = found.values as {
      labels: Record<string, string>;
      value: number;
      metricName?: string;
    }[];
    const count = samples.find(
      (v) =>
        v.metricName === `${metric}_count` &&
        Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    );
    return count?.value ?? 0;
  }

  it('records first-token and completion latency on a successful stream', async () => {
    const before = {
      firstToken: await observationCount('ai_summary_first_token_seconds', { tier: 'pro' }),
      complete: await observationCount('ai_summary_complete_seconds', {
        tier: 'pro',
        outcome: 'complete',
      }),
    };

    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        onText('Revenue ');
        onText('is up.');
        return { fullText: 'Revenue is up.', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    );

    const { res } = createMockRes();
    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    expect(
      await observationCount('ai_summary_first_token_seconds', { tier: 'pro' }),
    ).toBe(before.firstToken + 1);
    expect(
      await observationCount('ai_summary_complete_seconds', {
        tier: 'pro',
        outcome: 'complete',
      }),
    ).toBe(before.complete + 1);
  });

  it('records first-token latency once, not once per delta', async () => {
    const before = await observationCount('ai_summary_first_token_seconds', { tier: 'pro' });

    mockStreamInterpretation.mockImplementation(
      async (_prompt: string, onText: (d: string) => void) => {
        for (const word of ['a ', 'b ', 'c ', 'd ']) onText(word);
        return { fullText: 'a b c d ', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    );

    const { res } = createMockRes();
    const { streamToSSE } = await import('./streamHandler.js');
    await streamToSSE(res, 1, 42, 99, 'pro');

    expect(
      await observationCount('ai_summary_first_token_seconds', { tier: 'pro' }),
    ).toBe(before + 1);
  });
});
