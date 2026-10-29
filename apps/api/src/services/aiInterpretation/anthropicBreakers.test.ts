import { beforeEach, describe, expect, it, vi } from 'vitest';

interface BreakerOptions {
  name: string;
  threshold: number;
  cooldownMs: number;
  isIgnored: (error: unknown) => boolean;
}

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{ options: BreakerOptions; exec: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../../lib/circuitBreaker.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation(function (options: BreakerOptions) {
    const exec = vi.fn((operation: () => Promise<unknown>) => operation());
    mocks.instances.push({ options, exec });
    return { exec };
  }),
}));
vi.mock('./anthropicRuntime.js', () => ({
  AbortedByClient: class AbortedByClient extends Error {
    constructor() {
      super('aborted by client');
    }
  },
}));

import { CostBudgetExceededError } from '../../lib/appError.js';
import { createAnthropicBreakerRunners } from './anthropicBreakers.js';
import { AbortedByClient } from './anthropicRuntime.js';

describe('Anthropic breaker construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.instances.length = 0;
  });

  it('creates independent prose, tool, and conversation breakers', () => {
    createAnthropicBreakerRunners();

    expect(mocks.instances.map(({ options }) => options.name)).toEqual([
      'claude-api',
      'claude-api-tool',
      'claude-api-converse',
    ]);
    for (const { options } of mocks.instances) {
      expect(options.threshold).toBe(3);
      expect(options.cooldownMs).toBe(30_000);
    }
  });

  it('ignores client aborts and cost refusals but not upstream failures', () => {
    createAnthropicBreakerRunners();
    const predicate = mocks.instances[0]!.options.isIgnored;

    expect(predicate(new AbortedByClient())).toBe(true);
    expect(predicate(new CostBudgetExceededError(1, 0.5))).toBe(true);
    expect(predicate(new Error('upstream failed'))).toBe(false);
  });

  it('routes each returned runner through its corresponding breaker', async () => {
    const runners = createAnthropicBreakerRunners();

    await expect(runners.runProse(async () => 'prose')).resolves.toBe('prose');
    await expect(runners.runTool(async () => 'tool')).resolves.toBe('tool');
    await expect(runners.runConverse(async () => 'converse')).resolves.toBe('converse');

    expect(mocks.instances.map(({ exec }) => exec.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
