import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentProposal } from 'shared/agent';

const mockGetAgentEnabled = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetActiveCorrections = vi.fn().mockResolvedValue([]);
const mockRunCurationPipeline = vi.fn().mockResolvedValue([]);
const mockGenerateProposals = vi.fn().mockResolvedValue([]);
const mockGetRecentDedupKeys = vi.fn().mockResolvedValue([]);
const mockInsertProposal = vi.fn();
const mockHasExceededRunBudget = vi.fn().mockResolvedValue(false);
const mockRecordRunSpend = vi.fn().mockResolvedValue(undefined);
const mockBudgetExceededInc = vi.fn();

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string, public opts: unknown) {}
  },
}));
vi.mock('../../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/db.js', () => ({ dbAdmin: { __tag: 'dbAdmin' } }));
vi.mock('../../../lib/metrics.js', () => ({
  agentRunBudgetExceeded: { inc: mockBudgetExceededInc },
}));
vi.mock('../runBudget.js', () => ({
  hasExceededRunBudget: mockHasExceededRunBudget,
  recordRunSpend: mockRecordRunSpend,
}));

vi.mock('../../../db/queries/index.js', () => ({
  subscriptionsQueries: { getAgentEnabled: mockGetAgentEnabled },
  orgsQueries: { getActiveDatasetId: mockGetActiveDatasetId, findOrgById: mockFindOrgById },
  agentProposalsQueries: { getRecentDedupKeys: mockGetRecentDedupKeys, insertProposal: mockInsertProposal },
  statCorrectionsQueries: { getActiveCorrectionStatIds: mockGetActiveCorrections },
}));

vi.mock('../../../services/curation/index.js', () => ({
  runCurationPipeline: mockRunCurationPipeline,
}));

vi.mock('../../../services/curation/proposals.js', () => ({
  generateProposals: mockGenerateProposals,
}));

const { handleEvaluateOrgJob } = await import('./evaluateOrg.js');

const baseOrg = { id: 42, name: 'Acme Coffee', businessProfile: null };
const jobData = { orgId: 42, datasetId: 100, correlationId: 'req-abc' };

function proposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Marketing spend up',
    explanation: 'Marketing category spend rose relative to prior months.',
    recommendation: 'Consider reviewing recent marketing spend.',
    confidence: 0.8,
    evidence: ['1:trend:Marketing:0'],
    dedupKey: 'trend:marketing:default',
    period: '2026-W26',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentEnabled.mockResolvedValue(true);
  mockGetActiveDatasetId.mockResolvedValue(100);
  mockFindOrgById.mockResolvedValue(baseOrg);
  mockGetActiveCorrections.mockResolvedValue([]);
  mockRunCurationPipeline.mockResolvedValue([]);
  mockGenerateProposals.mockResolvedValue([]);
  mockGetRecentDedupKeys.mockResolvedValue([]);
  mockInsertProposal.mockResolvedValue({ id: 1 });
  mockHasExceededRunBudget.mockResolvedValue(false);
  mockRecordRunSpend.mockResolvedValue(undefined);
});

describe('handleEvaluateOrgJob: routing', () => {
  it('routes a fresh low-impact finding to auto_notify and persists it pending', async () => {
    mockGenerateProposals.mockResolvedValueOnce([proposal()]);

    await handleEvaluateOrgJob({ id: 'eval-1', data: jobData } as never);

    expect(mockInsertProposal).toHaveBeenCalledTimes(1);
    const input = mockInsertProposal.mock.calls[0]![0];
    expect(input).toMatchObject({
      orgId: 42,
      lane: 'auto_notify',
      status: 'pending',
      dedupKey: 'trend:marketing:default',
    });
    expect(input.expiresAt).toBeInstanceOf(Date);
  });

  it('routes a fresh finding with a mutating action to needs_approval even though it is unseen', async () => {
    mockGenerateProposals.mockResolvedValueOnce([
      proposal({
        dedupKey: 'reconciliation:invoice-9:default',
        kind: 'reconciliation',
        action: { type: 'reclassify', targetRef: 'invoice-9' },
      }),
    ]);

    await handleEvaluateOrgJob({ id: 'eval-2', data: jobData } as never);

    expect(mockInsertProposal).toHaveBeenCalledTimes(1);
    expect(mockInsertProposal.mock.calls[0]![0]).toMatchObject({ lane: 'needs_approval', status: 'pending' });
  });

  it('suppresses (and does not persist) a finding whose dedupKey was seen within the window', async () => {
    mockGetRecentDedupKeys.mockResolvedValueOnce(['trend:marketing:default']);
    mockGenerateProposals.mockResolvedValueOnce([proposal()]);

    await handleEvaluateOrgJob({ id: 'eval-3', data: jobData } as never);

    expect(mockInsertProposal).not.toHaveBeenCalled();
  });

  it('suppresses a finding below the confidence floor', async () => {
    mockGenerateProposals.mockResolvedValueOnce([proposal({ confidence: 0.3 })]);

    await handleEvaluateOrgJob({ id: 'eval-4', data: jobData } as never);

    expect(mockInsertProposal).not.toHaveBeenCalled();
  });

  it('completes cleanly when generateProposals returns nothing', async () => {
    mockGenerateProposals.mockResolvedValueOnce([]);

    await expect(handleEvaluateOrgJob({ id: 'eval-5', data: jobData } as never)).resolves.toBeUndefined();

    expect(mockInsertProposal).not.toHaveBeenCalled();
  });
});

describe('handleEvaluateOrgJob: re-verification', () => {
  it('skips processing without a retry when entitlement was revoked since enqueue', async () => {
    mockGetAgentEnabled.mockResolvedValueOnce(false);

    await handleEvaluateOrgJob({ id: 'eval-6', data: jobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
    expect(mockGenerateProposals).not.toHaveBeenCalled();
  });

  it('skips processing when the org has no active dataset', async () => {
    mockGetActiveDatasetId.mockResolvedValueOnce(null);

    await handleEvaluateOrgJob({ id: 'eval-7', data: jobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('skips processing when the org row is missing', async () => {
    mockFindOrgById.mockResolvedValueOnce(undefined);

    await handleEvaluateOrgJob({ id: 'eval-8', data: jobData } as never);

    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });
});

describe('handleEvaluateOrgJob: failure propagation', () => {
  it('lets a curation pipeline error propagate so BullMQ retries', async () => {
    const err = new Error('curation exploded');
    mockRunCurationPipeline.mockRejectedValueOnce(err);

    await expect(handleEvaluateOrgJob({ id: 'eval-9', data: jobData } as never)).rejects.toBe(err);
  });

  it('lets a proposal-generation error propagate so BullMQ retries', async () => {
    const err = new Error('LLM call failed');
    mockGenerateProposals.mockRejectedValueOnce(err);

    await expect(handleEvaluateOrgJob({ id: 'eval-10', data: jobData } as never)).rejects.toBe(err);
  });
});

describe('handleEvaluateOrgJob: run cost ceiling', () => {
  it('skips generateProposals and logs when the run has exceeded its budget', async () => {
    mockHasExceededRunBudget.mockResolvedValueOnce(true);

    await handleEvaluateOrgJob({ id: 'eval-budget-1', data: jobData } as never);

    expect(mockGenerateProposals).not.toHaveBeenCalled();
    expect(mockBudgetExceededInc).toHaveBeenCalledWith({ stage: 'evaluate-org' });
  });

  it('checks the budget before the entitlement/dataset/org lookups, not after', async () => {
    mockHasExceededRunBudget.mockResolvedValueOnce(true);

    await handleEvaluateOrgJob({ id: 'eval-budget-5', data: jobData } as never);

    expect(mockGetAgentEnabled).not.toHaveBeenCalled();
    expect(mockGetActiveDatasetId).not.toHaveBeenCalled();
    expect(mockFindOrgById).not.toHaveBeenCalled();
  });

  it('records spend via the onCost callback after a successful generateProposals call', async () => {
    mockGenerateProposals.mockImplementationOnce(async (_insights, _datasetId, _profile, _now, onCost) => {
      onCost?.(0.07);
      return [];
    });

    await handleEvaluateOrgJob({ id: 'eval-budget-2', data: jobData } as never);

    expect(mockRecordRunSpend).toHaveBeenCalledWith('req-abc', 0.07);
  });

  it('does not record spend when the cost callback reports null', async () => {
    mockGenerateProposals.mockImplementationOnce(async (_insights, _datasetId, _profile, _now, onCost) => {
      onCost?.(null);
      return [];
    });

    await handleEvaluateOrgJob({ id: 'eval-budget-3', data: jobData } as never);

    expect(mockRecordRunSpend).not.toHaveBeenCalled();
  });

  it('still records already-incurred spend when generateProposals throws after onCost fires', async () => {
    const err = new Error('safety cap exceeded');
    mockGenerateProposals.mockImplementationOnce(async (_insights, _datasetId, _profile, _now, onCost) => {
      onCost?.(0.12);
      throw err;
    });

    await expect(handleEvaluateOrgJob({ id: 'eval-budget-4', data: jobData } as never)).rejects.toBe(err);

    expect(mockRecordRunSpend).toHaveBeenCalledWith('req-abc', 0.12);
  });
});

describe('handleEvaluateOrgJob: invalid job payload', () => {
  it('skips and logs a warning when the payload fails schema validation', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleEvaluateOrgJob({ id: 'eval-bad-1', data: { orgId: 42 } } as never);

    expect(mockGetAgentEnabled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'eval-bad-1' }),
      'invalid job payload, skipping',
    );
  });
});
