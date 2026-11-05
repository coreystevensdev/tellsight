import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCachedAlertSummary = vi.fn();
const mockFindOrgById = vi.fn();
const mockStoreSummary = vi.fn();
const mockGenerateInterpretation = vi.fn();

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/queries/index.js', () => ({
  aiSummariesQueries: { getCachedAlertSummary: mockGetCachedAlertSummary, storeSummary: mockStoreSummary },
  orgsQueries: { findOrgById: mockFindOrgById },
}));

vi.mock('../../../services/aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: mockGenerateInterpretation,
}));

// No node:fs mock: v1-alert.md is a real single-file template on disk, same
// as promptTemplates.test.ts's v1-agent coverage. This exercises the real
// assemblePrompt, not a stand-in for it.
const { resolveAlertParagraph } = await import('./alertParagraph.js');

// Runway's floor is 3. A business three months into its first upload is
// exactly the case ruleEvaluation.ts can fire runway_runs_short on, and the
// case this fixture reproduces: one real month of runway math, not six.
function belowFloorRunwayInsight() {
  return {
    stat: {
      statType: 'runway',
      category: null,
      value: 1.2,
      sampleSize: 1,
      details: {
        cashOnHand: 4_000,
        monthlyNet: -3_300,
        runwayMonths: 1.2,
        cashAsOfDate: '2026-07-01',
        confidence: 'high' as const,
        trailingMonths: 3,
      },
    },
    score: 0.9,
    breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.9 },
  };
}

const baseJobData = {
  orgId: 42,
  orgName: 'Acme Coffee',
  userId: 7,
  userEmail: 'owner@acme.test',
  datasetId: 100,
  ruleId: 1,
  ruleKind: 'runway_runs_short' as const,
  fireId: 999,
  currentValue: 1.2,
  firedInsight: belowFloorRunwayInsight(),
  trigger: 'cron' as const,
  correlationId: 'corr-1',
};

describe('resolveAlertParagraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedAlertSummary.mockResolvedValue(undefined);
    mockFindOrgById.mockResolvedValue({ businessProfile: null });
    mockStoreSummary.mockResolvedValue({});
  });

  it('renders a below-floor firedInsight instead of falling through to the empty-insights prompt', async () => {
    mockGenerateInterpretation.mockResolvedValue('Runway is tight this month, worth a look.');

    const result = await resolveAlertParagraph(baseJobData as never);

    expect(mockGenerateInterpretation).toHaveBeenCalledTimes(1);
    const promptArg = mockGenerateInterpretation.mock.calls[0]![0] as { user: string };
    expect(promptArg.user).toContain('Runway:');
    expect(promptArg.user).not.toContain('No statistical insights available');

    // Reached the real LLM call and cached its answer, not the deterministic
    // fallbackParagraph the catch block reaches for on a genuine failure.
    expect(result).toBe('Runway is tight this month, worth a look.');
    const storeCall = mockStoreSummary.mock.calls[0]![0] as { metadata: { suppressedForSampleSize: number } };
    expect(storeCall.metadata.suppressedForSampleSize).toBe(0);
  });
});
