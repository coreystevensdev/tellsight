import { describe, it, expect } from 'vitest';
import { streamReducer, stripStatTags, type StreamState } from './useAiStream';

const idle: StreamState = {
  status: 'idle',
  text: '',
  rawText: '',
  metadata: null,
  error: null,
  code: null,
  retryable: false,
  retryCount: 0,
};

describe('streamReducer', () => {
  it('START transitions from idle to connecting', () => {
    const next = streamReducer(idle, { type: 'START' });
    expect(next.status).toBe('connecting');
    expect(next.text).toBe('');
    expect(next.error).toBeNull();
    expect(next.retryCount).toBe(0);
  });

  it('START with isRetry increments retryCount', () => {
    const error: StreamState = { ...idle, status: 'error', retryCount: 1 };
    const next = streamReducer(error, { type: 'START', isRetry: true });
    expect(next.status).toBe('connecting');
    expect(next.retryCount).toBe(2);
  });

  it('START without isRetry resets retryCount to 0', () => {
    const error: StreamState = { ...idle, status: 'error', retryCount: 2 };
    const next = streamReducer(error, { type: 'START' });
    expect(next.retryCount).toBe(0);
  });

  it('START clears previous text and error', () => {
    const timeout: StreamState = {
      ...idle,
      status: 'timeout',
      text: 'old partial',
      retryCount: 1,
    };
    const next = streamReducer(timeout, { type: 'START', isRetry: true });
    expect(next.text).toBe('');
    expect(next.error).toBeNull();
    expect(next.code).toBeNull();
  });

  it('TEXT transitions from connecting to streaming and appends delta', () => {
    const connecting: StreamState = { ...idle, status: 'connecting' };
    const next = streamReducer(connecting, { type: 'TEXT', delta: 'Hello ' });
    expect(next.status).toBe('streaming');
    expect(next.text).toBe('Hello ');
  });

  it('TEXT appends to existing text in streaming state', () => {
    const streaming: StreamState = {
      ...idle,
      status: 'streaming',
      text: 'Hello ',
      rawText: 'Hello ',
    };
    const next = streamReducer(streaming, { type: 'TEXT', delta: 'world' });
    expect(next.text).toBe('Hello world');
  });

  it('DONE transitions to done preserving text', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'Full response' };
    const next = streamReducer(streaming, { type: 'DONE' });
    expect(next.status).toBe('done');
    expect(next.text).toBe('Full response');
  });

  it('DONE is a no-op when status is timeout', () => {
    const timeout: StreamState = { ...idle, status: 'timeout', text: 'partial text' };
    const next = streamReducer(timeout, { type: 'DONE' });
    expect(next.status).toBe('timeout');
    expect(next.text).toBe('partial text');
    expect(next).toBe(timeout);
  });

  it('ERROR transitions to error with message', () => {
    const connecting: StreamState = { ...idle, status: 'connecting' };
    const next = streamReducer(connecting, { type: 'ERROR', message: 'Network error' });
    expect(next.status).toBe('error');
    expect(next.error).toBe('Network error');
  });

  it('ERROR stores code and retryable flag', () => {
    const connecting: StreamState = { ...idle, status: 'connecting' };
    const next = streamReducer(connecting, {
      type: 'ERROR',
      message: 'Too many requests',
      code: 'RATE_LIMITED',
      retryable: false,
    });
    expect(next.code).toBe('RATE_LIMITED');
    expect(next.retryable).toBe(false);
  });

  it('ERROR defaults retryable to false and code to null', () => {
    const connecting: StreamState = { ...idle, status: 'connecting' };
    const next = streamReducer(connecting, { type: 'ERROR', message: 'fail' });
    expect(next.code).toBeNull();
    expect(next.retryable).toBe(false);
  });

  it('ERROR from streaming preserves accumulated text', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'Partial' };
    const next = streamReducer(streaming, {
      type: 'ERROR',
      message: 'mid-stream failure',
      retryable: true,
    });
    expect(next.text).toBe('Partial');
    expect(next.error).toBe('mid-stream failure');
    expect(next.retryable).toBe(true);
  });

  it('PARTIAL transitions to timeout with accumulated text', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'streamed so far' };
    const next = streamReducer(streaming, { type: 'PARTIAL', text: 'full accumulated text' });
    expect(next.status).toBe('timeout');
    expect(next.text).toBe('full accumulated text');
  });

  it('PARTIAL sets authoritative text (replaces, not appends)', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'chunk1 chunk2' };
    const next = streamReducer(streaming, { type: 'PARTIAL', text: 'chunk1 chunk2' });
    expect(next.text).toBe('chunk1 chunk2');
    expect(next.status).toBe('timeout');
  });

  it('PARTIAL stores metadata from action', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'streamed so far' };
    const metadata = {
      statTypes: ['trend'],
      categoryCount: 3,
      insightCount: 2,
      scoringWeights: { novelty: 0.4, actionability: 0.35, specificity: 0.25 },
      promptVersion: 'v1',
      generatedAt: '2026-03-14T12:00:00Z',
    };
    const next = streamReducer(streaming, { type: 'PARTIAL', text: 'partial text', metadata });
    expect(next.status).toBe('timeout');
    expect(next.metadata).toEqual(metadata);
  });

  it('PARTIAL without metadata sets metadata to null', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'streamed' };
    const next = streamReducer(streaming, { type: 'PARTIAL', text: 'partial text' });
    expect(next.metadata).toBeNull();
  });

  it('CACHE_HIT transitions directly to done with content', () => {
    const next = streamReducer(idle, { type: 'CACHE_HIT', content: 'Cached text' });
    expect(next.status).toBe('done');
    expect(next.text).toBe('Cached text');
    expect(next.retryCount).toBe(0);
  });

  it('RESET returns to idle', () => {
    const done: StreamState = { ...idle, status: 'done', text: 'text', retryCount: 2 };
    const next = streamReducer(done, { type: 'RESET' });
    expect(next).toEqual(idle);
  });

  it('UPGRADE_REQUIRED sets free_preview and preserves text', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'Here is your summary' };
    const next = streamReducer(streaming, { type: 'UPGRADE_REQUIRED', wordCount: 150 });
    expect(next.status).toBe('free_preview');
    expect(next.text).toBe('Here is your summary');
  });

  it('DONE after UPGRADE_REQUIRED is a no-op', () => {
    const preview: StreamState = { ...idle, status: 'free_preview', text: 'preview text' };
    const next = streamReducer(preview, { type: 'DONE' });
    expect(next.status).toBe('free_preview');
    expect(next.text).toBe('preview text');
    expect(next).toBe(preview);
  });

  it('DONE stores metadata from action', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'response' };
    const metadata = {
      statTypes: ['trend', 'anomaly'],
      categoryCount: 5,
      insightCount: 3,
      scoringWeights: { novelty: 0.4, actionability: 0.35, specificity: 0.25 },
      promptVersion: 'v1',
      generatedAt: '2026-03-14T12:00:00Z',
    };
    const next = streamReducer(streaming, { type: 'DONE', metadata });
    expect(next.status).toBe('done');
    expect(next.metadata).toEqual(metadata);
  });

  it('DONE without metadata sets metadata to null', () => {
    const streaming: StreamState = { ...idle, status: 'streaming', text: 'response' };
    const next = streamReducer(streaming, { type: 'DONE' });
    expect(next.metadata).toBeNull();
  });

  it('CACHE_HIT stores metadata from action', () => {
    const metadata = {
      statTypes: ['total'],
      categoryCount: 3,
      insightCount: 2,
      scoringWeights: { novelty: 0.4, actionability: 0.35, specificity: 0.25 },
      promptVersion: 'v1',
      generatedAt: '2026-03-14T12:00:00Z',
    };
    const next = streamReducer(idle, { type: 'CACHE_HIT', content: 'cached', metadata });
    expect(next.status).toBe('done');
    expect(next.text).toBe('cached');
    expect(next.metadata).toEqual(metadata);
  });

  it('CACHE_HIT without metadata sets metadata to null', () => {
    const next = streamReducer(idle, { type: 'CACHE_HIT', content: 'cached' });
    expect(next.metadata).toBeNull();
  });

  it('retry count survives through START isRetry chain', () => {
    let state = idle;
    state = streamReducer(state, { type: 'START' }); // retryCount = 0
    state = streamReducer(state, { type: 'ERROR', message: 'fail', retryable: true });
    state = streamReducer(state, { type: 'START', isRetry: true }); // retryCount = 1
    state = streamReducer(state, { type: 'ERROR', message: 'fail', retryable: true });
    state = streamReducer(state, { type: 'START', isRetry: true }); // retryCount = 2
    state = streamReducer(state, { type: 'ERROR', message: 'fail', retryable: true });
    state = streamReducer(state, { type: 'START', isRetry: true }); // retryCount = 3
    expect(state.retryCount).toBe(3);
  });
});

describe('stripStatTags', () => {
  it('strips a complete tag in one chunk', () => {
    expect(stripStatTags('runway is 3 months <stat id="runway"/> tight'))
      .toBe('runway is 3 months  tight');
  });

  it('strips multiple tags in one string', () => {
    expect(stripStatTags('<stat id="a"/>x<stat id="b"/>y')).toBe('xy');
  });

  it('hides an incomplete trailing tag fragment', () => {
    // chunk arrives mid-tag, the fragment must not render
    expect(stripStatTags('prose <stat')).toBe('prose ');
    expect(stripStatTags('prose <stat id')).toBe('prose ');
    expect(stripStatTags('prose <stat id="runw')).toBe('prose ');
  });

  it('leaves text unchanged when no tags are present', () => {
    const raw = 'just a normal paragraph with no tags at all.';
    expect(stripStatTags(raw)).toBe(raw);
  });

  it('leaves malformed tags as-is (does not crash)', () => {
    // empty id fails the complete-tag regex; treated as literal prose
    expect(stripStatTags('bad <stat id=/> tag')).toBe('bad <stat id=/> tag');
  });

  it('does not mis-strip words that start with <stat', () => {
    // <statue of liberty is not a tag fragment (no whitespace after stat)
    expect(stripStatTags('a <statue of freedom')).toBe('a <statue of freedom');
  });
});

describe('streamReducer tag handling', () => {
  it('TEXT action preserves rawText and exposes stripped text', () => {
    const connecting: StreamState = { ...idle, status: 'connecting' };
    const next = streamReducer(connecting, {
      type: 'TEXT',
      delta: 'runway is 3.2 months <stat id="runway"/> worth watching',
    });
    expect(next.rawText).toBe('runway is 3.2 months <stat id="runway"/> worth watching');
    expect(next.text).toBe('runway is 3.2 months  worth watching');
  });

  it('TEXT action hides boundary-split tag until next chunk completes it', () => {
    let state: StreamState = { ...idle, status: 'connecting' };
    state = streamReducer(state, { type: 'TEXT', delta: 'runway is 3.2 months <stat id="runw' });
    expect(state.rawText).toBe('runway is 3.2 months <stat id="runw');
    expect(state.text).toBe('runway is 3.2 months '); // fragment hidden

    state = streamReducer(state, { type: 'TEXT', delta: 'ay"/> worth watching' });
    expect(state.rawText).toBe('runway is 3.2 months <stat id="runway"/> worth watching');
    expect(state.text).toBe('runway is 3.2 months  worth watching'); // fragment now complete + stripped
  });

  it('PARTIAL action strips tags from the partial text', () => {
    const streaming: StreamState = { ...idle, status: 'streaming' };
    const next = streamReducer(streaming, {
      type: 'PARTIAL',
      text: 'timeout snapshot <stat id="cash_flow"/>',
    });
    expect(next.status).toBe('timeout');
    expect(next.rawText).toBe('timeout snapshot <stat id="cash_flow"/>');
    expect(next.text).toBe('timeout snapshot ');
  });

  it('CACHE_HIT action strips tags from cached content', () => {
    const next = streamReducer(idle, {
      type: 'CACHE_HIT',
      content: 'cached prose <stat id="margin_trend"/> end',
    });
    expect(next.status).toBe('done');
    expect(next.rawText).toBe('cached prose <stat id="margin_trend"/> end');
    expect(next.text).toBe('cached prose  end');
  });

  it('RESET action clears rawText alongside text', () => {
    const streaming: StreamState = {
      ...idle,
      status: 'streaming',
      text: 'stuff',
      rawText: 'stuff <stat id="x"/>',
    };
    const next = streamReducer(streaming, { type: 'RESET' });
    expect(next.rawText).toBe('');
    expect(next.text).toBe('');
  });

  it('START action clears rawText alongside text', () => {
    const done: StreamState = {
      ...idle,
      status: 'done',
      text: 'result',
      rawText: 'result <stat id="runway"/>',
    };
    const next = streamReducer(done, { type: 'START' });
    expect(next.rawText).toBe('');
    expect(next.text).toBe('');
  });
});
