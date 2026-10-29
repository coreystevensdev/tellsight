import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  computeCost: vi.fn(),
  exceedsBudget: vi.fn(),
  recordCost: vi.fn(),
  budgetInc: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../lib/cost.js', () => ({
  computeCost: mocks.computeCost,
  exceedsBudget: mocks.exceedsBudget,
  recordCost: mocks.recordCost,
}));
vi.mock('../../lib/metrics.js', () => ({
  aiCostBudgetExceeded: { inc: mocks.budgetInc },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));
vi.mock('@anthropic-ai/sdk', () => {
  class AuthenticationError extends Error {}
  class BadRequestError extends Error {}
  return {
    default: Object.assign(class Anthropic {}, { AuthenticationError, BadRequestError }),
  };
});

import { CostBudgetExceededError, ExternalServiceError } from '../../lib/appError.js';
import { applyCostGate, mapAnthropicError } from './anthropicRuntime.js';

const usage = { input_tokens: 100, output_tokens: 25 };
const AnthropicErrors = Anthropic as unknown as {
  AuthenticationError: new (message: string) => Error;
  BadRequestError: new (message: string) => Error;
};

describe('Anthropic runtime policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeCost.mockReturnValue(0.02);
    mocks.exceedsBudget.mockReturnValue({ exceeded: false, cap: null, median: null });
  });

  it('records and returns an allowed request cost', () => {
    expect(applyCostGate(usage, 'generate', 'claude-test')).toBe(0.02);
    expect(mocks.computeCost).toHaveBeenCalledWith(usage, 'claude-test');
    expect(mocks.recordCost).toHaveBeenCalledWith(0.02);
    expect(mocks.budgetInc).not.toHaveBeenCalled();
  });

  it('logs and skips accounting when the model has no price', () => {
    mocks.computeCost.mockReturnValue(null);

    expect(applyCostGate(usage, 'generateWithModel', 'unknown-model')).toBeNull();
    expect(mocks.exceedsBudget).not.toHaveBeenCalled();
    expect(mocks.recordCost).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      { model: 'unknown-model', caller: 'generateWithModel' },
      'No pricing for model, cost gate skipped',
    );
  });

  it('throws and records a metric without polluting history on an overrun', () => {
    mocks.exceedsBudget.mockReturnValue({ exceeded: true, cap: 0.5, median: 0.1 });

    expect(() => applyCostGate(usage, 'generateTool', 'claude-test')).toThrow(
      CostBudgetExceededError,
    );
    expect(mocks.budgetInc).toHaveBeenCalledWith({ caller: 'generateTool' });
    expect(mocks.recordCost).not.toHaveBeenCalled();
  });

  it('preserves cost-budget errors unchanged', () => {
    const error = new CostBudgetExceededError(1, 0.5);

    expect(() => mapAnthropicError(error)).toThrow(error);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication', new AnthropicErrors.AuthenticationError('bad key')],
    ['bad request', new AnthropicErrors.BadRequestError('bad prompt')],
  ])('logs %s failures as non-retryable and wraps them', (_label, error) => {
    expect(() => mapAnthropicError(error)).toThrow(ExternalServiceError);
    expect(mocks.error).toHaveBeenCalledWith(
      { err: error.message },
      'Claude API non-retryable error',
    );
  });

  it('logs exhausted transient failures at warn level and wraps them', () => {
    const error = new Error('overloaded');

    expect(() => mapAnthropicError(error)).toThrow(ExternalServiceError);
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: 'overloaded' },
      'Claude API retryable error exhausted',
    );
  });
});
