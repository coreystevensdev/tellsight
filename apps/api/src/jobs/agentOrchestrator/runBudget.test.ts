import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockIncrbyfloat = vi.fn();
const mockExpire = vi.fn();
const mockExec = vi.fn();
const mockMulti = vi.fn(() => ({ incrbyfloat: mockIncrbyfloat, expire: mockExpire, exec: mockExec }));

vi.mock('../../config.js', () => ({ env: { AGENT_RUN_COST_CEILING_USD: 50 } }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../lib/redis.js', () => ({
  redis: { get: mockGet, multi: mockMulti },
}));

const { recordRunSpend, hasExceededRunBudget } = await import('./runBudget.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockIncrbyfloat.mockReturnThis();
  mockExpire.mockReturnThis();
  mockExec.mockResolvedValue([]);
  mockGet.mockResolvedValue(null);
});

describe('recordRunSpend', () => {
  it('pipelines the increment and a 24h TTL through one multi/exec', async () => {
    await recordRunSpend('run-1', 0.42);

    expect(mockIncrbyfloat).toHaveBeenCalledWith('agent-orchestrator:run-spend:run-1', 0.42);
    expect(mockExpire).toHaveBeenCalledWith('agent-orchestrator:run-spend:run-1', 86_400);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('fails open and logs a warning when Redis throws', async () => {
    const { logger } = await import('../../lib/logger.js');
    mockExec.mockRejectedValueOnce(new Error('connection refused'));

    await expect(recordRunSpend('run-1', 1)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'run-1' }),
      'Failed to record agent run spend, continuing uncapped for this call',
    );
  });
});

describe('hasExceededRunBudget', () => {
  it('returns false when accumulated spend is under the ceiling', async () => {
    mockGet.mockResolvedValueOnce('49.99');

    await expect(hasExceededRunBudget('run-1')).resolves.toBe(false);
  });

  it('returns true once accumulated spend crosses the ceiling', async () => {
    mockGet.mockResolvedValueOnce('50.01');

    await expect(hasExceededRunBudget('run-1')).resolves.toBe(true);
  });

  it('returns false when nothing has been recorded yet', async () => {
    mockGet.mockResolvedValueOnce(null);

    await expect(hasExceededRunBudget('run-1')).resolves.toBe(false);
  });

  it('fails open (not exceeded) and logs a warning when Redis throws', async () => {
    const { logger } = await import('../../lib/logger.js');
    mockGet.mockRejectedValueOnce(new Error('connection refused'));

    await expect(hasExceededRunBudget('run-1')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'run-1' }),
      'Failed to read agent run spend, proceeding as if under budget',
    );
  });

  it('fails open (not exceeded) and logs a warning when the stored value is non-numeric', async () => {
    const { logger } = await import('../../lib/logger.js');
    mockGet.mockResolvedValueOnce('not-a-number');

    await expect(hasExceededRunBudget('run-1')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'run-1', raw: 'not-a-number' }),
      'Agent run spend key held a non-numeric value, proceeding as if under budget',
    );
  });
});
