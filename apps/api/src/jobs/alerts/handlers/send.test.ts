import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendEmail = vi.fn();
const mockGetCachedAlertSummary = vi.fn();
const mockStoreSummary = vi.fn();
const mockFindOrgById = vi.fn();
const mockGenerateInterpretation = vi.fn();
const mockRenderChart = vi.fn();
const mockAlertEmail = vi.fn((props: unknown) => props);

class FakeEmailSendError extends Error {
  retryable: boolean;
  providerStatusCode?: number;
  constructor(message: string, opts: { retryable: boolean; providerStatusCode?: number }) {
    super(message);
    this.name = 'EmailSendError';
    this.retryable = opts.retryable;
    this.providerStatusCode = opts.providerStatusCode;
  }
}

vi.mock('../../../config.js', () => ({
  env: {
    APP_URL: 'https://app.tellsight.test',
    JWT_SECRET: 'a'.repeat(64),
    EMAIL_MAILING_ADDRESS: '123 Some Real Street, Anywhere, ZZ 00000',
    EMAIL_FROM_NAME: 'Tellsight',
  },
}));

const mockSetTag = vi.fn();
vi.mock('../../../lib/sentry.js', () => ({
  Sentry: { withScope: (cb: (scope: { setTag: typeof mockSetTag }) => unknown) => cb({ setTag: mockSetTag }) },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../services/email/index.js', () => ({
  sendEmail: mockSendEmail,
  EmailSendError: FakeEmailSendError,
}));

vi.mock('../../../db/queries/index.js', () => ({
  aiSummariesQueries: { getCachedAlertSummary: mockGetCachedAlertSummary, storeSummary: mockStoreSummary },
  orgsQueries: { findOrgById: mockFindOrgById },
}));

vi.mock('../../../services/aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: mockGenerateInterpretation,
}));

vi.mock('../../../services/charting/renderChart.js', () => ({
  renderChart: mockRenderChart,
}));

vi.mock('../templates/alertEmail.js', () => ({
  AlertEmail: mockAlertEmail,
  buildAlertRecipientExplanation: (label: string, orgName: string) =>
    `You're receiving this because you have an active alert rule for ${label} in ${orgName}`,
}));

const { handleSendJob } = await import('./send.js');

function runwayInsight(runwayMonths = 2) {
  return {
    stat: {
      statType: 'runway',
      category: null,
      value: runwayMonths,
      details: {
        cashOnHand: 10_000,
        monthlyNet: -2_500,
        runwayMonths,
        cashAsOfDate: '2026-07-01',
        confidence: 'high' as const,
      },
    },
    score: 0.9,
    breakdown: { novelty: 0.8, actionability: 0.9, specificity: 0.9 },
  };
}

function breakevenInsight() {
  return {
    stat: {
      statType: 'break_even',
      category: null,
      value: 5_000,
      details: {
        monthlyFixedCosts: 8_000,
        marginPercent: 20,
        breakEvenRevenue: 40_000,
        currentMonthlyRevenue: 35_000,
        gap: 5_000,
        confidence: 'high' as const,
      },
    },
    score: 0.8,
    breakdown: { novelty: 0.7, actionability: 0.8, specificity: 0.8 },
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
  currentValue: 2,
  firedInsight: runwayInsight(),
  trigger: 'cron' as const,
  correlationId: 'corr-123',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ status: 'captured', providerMessageId: 'msg-1', durationMs: 5 });
  mockGetCachedAlertSummary.mockResolvedValue(undefined);
  mockFindOrgById.mockResolvedValue({ businessProfile: null });
  mockGenerateInterpretation.mockResolvedValue('Your runway is now 2.0 months. Worth a look at burn rate.');
  mockRenderChart.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

describe('handleSendJob: chart-mapped rule kind (I/O matrix row 1)', () => {
  it('renders and attaches a chart, tags Sentry with chart_kind', async () => {
    await handleSendJob({ id: 'send-1', data: baseJobData } as never);

    expect(mockRenderChart).toHaveBeenCalledWith(
      { chartKind: 'runway', data: { cashOnHand: 10_000, monthlyNet: -2_500, runwayMonths: 2 } },
      { correlationId: 'corr-123', orgId: 42, ruleId: 1 },
    );

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.to).toBe('owner@acme.test');
    expect(call.subject).toBe('Your cash runway is running short');
    expect(call.tags).toMatchObject({ template: 'alert-v1', org_id: '42', rule_id: '1' });
    expect(call.attachments).toEqual([
      { filename: 'chart.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentId: 'chart-999' },
    ]);
    expect((call.react as { chartContentId?: string }).chartContentId).toBe('chart-999');

    expect(mockSetTag).toHaveBeenCalledWith('chart_kind', 'runway');
  });

  it('calls the LLM with the fired insight and caches the result', async () => {
    await handleSendJob({ id: 'send-2', data: baseJobData } as never);

    expect(mockGenerateInterpretation).toHaveBeenCalledTimes(1);
    expect(mockStoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 42, datasetId: 100, audience: 'alert', fireId: 999, promptVersion: 'v1-alert' }),
    );

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.react as { paragraph: string }).paragraph).toBe(
      'Your runway is now 2.0 months. Worth a look at burn rate.',
    );
  });

  it('uses the cached alert summary and skips the LLM call on a cache hit', async () => {
    mockGetCachedAlertSummary.mockResolvedValueOnce({ id: 5, content: 'cached paragraph' });

    await handleSendJob({ id: 'send-3', data: baseJobData } as never);

    expect(mockGenerateInterpretation).not.toHaveBeenCalled();
    expect(mockStoreSummary).not.toHaveBeenCalled();
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.react as { paragraph: string }).paragraph).toBe('cached paragraph');
  });
});

describe('handleSendJob: chart input statType mismatch', () => {
  it('logs a warning and sends text-only when the fired insight does not match the expected chart kind', async () => {
    const data = { ...baseJobData, firedInsight: breakevenInsight() };
    const { logger } = await import('../../../lib/logger.js');

    await handleSendJob({ id: 'send-12', data } as never);

    expect(mockRenderChart).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-123', orgId: 42, ruleId: 1, chartKind: 'runway' }),
      expect.stringContaining('does not match the expected chart kind'),
    );
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.attachments).toBeUndefined();
  });
});

describe('handleSendJob: text-only rule kind (I/O matrix row 2)', () => {
  it('breakeven_gap_widens never renders a chart and sets no chart_kind tag', async () => {
    const data = { ...baseJobData, ruleKind: 'breakeven_gap_widens' as const, firedInsight: breakevenInsight() };

    await handleSendJob({ id: 'send-4', data } as never);

    expect(mockRenderChart).not.toHaveBeenCalled();
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.attachments).toBeUndefined();
    expect((call.react as { chartContentId?: string }).chartContentId).toBeUndefined();
    expect(mockSetTag).not.toHaveBeenCalledWith('chart_kind', expect.anything());
  });
});

describe('handleSendJob: chart render degrades to text-only (I/O matrix rows 3 and 5)', () => {
  it('sends without an attachment when renderChart returns null', async () => {
    mockRenderChart.mockResolvedValueOnce(null);

    await handleSendJob({ id: 'send-5', data: baseJobData } as never);

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.attachments).toBeUndefined();
    expect((call.react as { chartContentId?: string }).chartContentId).toBeUndefined();
    // still tagged: the rule kind maps to a chart, rendering just degraded
    expect(mockSetTag).toHaveBeenCalledWith('chart_kind', 'runway');
  });
});

describe('handleSendJob: LLM failure fallback (I/O matrix row 4)', () => {
  it('falls back to the deterministic sentence and still sends', async () => {
    mockGenerateInterpretation.mockRejectedValueOnce(new Error('Claude timeout'));

    await handleSendJob({ id: 'send-6', data: baseJobData } as never);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.react as { paragraph: string }).paragraph).toBe(
      'Your cash runway is running short. Current value: 2.00.',
    );
    expect(mockStoreSummary).not.toHaveBeenCalled();
  });
});

describe('handleSendJob: CAN-SPAM headers and mute link', () => {
  it('carries a List-Unsubscribe header pointing at a verifiable mute link', async () => {
    await handleSendJob({ id: 'send-7', data: baseJobData } as never);

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    const headers = call.headers as Record<string, string>;
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const muteUrl = (call.react as { muteUrl: string }).muteUrl;
    expect(headers['List-Unsubscribe']).toBe(`<${muteUrl}>`);

    const { verifyMuteToken } = await import('../muteToken.js');
    const token = decodeURIComponent(new URL(muteUrl).pathname.split('/').pop()!);
    expect(verifyMuteToken(token)).toEqual({ ruleId: 1 });
  });
});

describe('handleSendJob: dashboard CTA click tracking', () => {
  it('signs a verifiable tracking token into the dashboard URL', async () => {
    await handleSendJob({ id: 'send-13', data: baseJobData } as never);

    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    const dashboardUrl = new URL((call.react as { dashboardUrl: string }).dashboardUrl);
    const token = dashboardUrl.searchParams.get('t');
    expect(token).not.toBeNull();

    const { verifyAlertTrackingToken } = await import('../trackingToken.js');
    expect(verifyAlertTrackingToken(token!)).toEqual({
      orgId: 42,
      userId: 7,
      ruleId: 1,
      ruleKind: 'runway_runs_short',
      fireId: 999,
    });
  });
});

describe('handleSendJob: Sentry + Pino observability', () => {
  it('tags org, rule, rule kind, and template version', async () => {
    await handleSendJob({ id: 'send-8', data: baseJobData } as never);

    expect(mockSetTag).toHaveBeenCalledWith('org_id', '42');
    expect(mockSetTag).toHaveBeenCalledWith('rule_id', '1');
    expect(mockSetTag).toHaveBeenCalledWith('rule_kind', 'runway_runs_short');
    expect(mockSetTag).toHaveBeenCalledWith('template_version', 'alert-v1');
  });

  it('logs correlationId, orgId, userId, ruleId, templateVersion, renderingDurationMs, outcome on success', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleSendJob({ id: 'send-9', data: baseJobData } as never);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'corr-123',
        orgId: 42,
        userId: 7,
        ruleId: 1,
        templateVersion: 'alert-v1',
        renderingDurationMs: expect.any(Number),
        outcome: 'sent',
      }),
      'Alert send complete',
    );
  });
});

describe('handleSendJob: provider failure handling', () => {
  it('re-throws a retryable EmailSendError so BullMQ retries', async () => {
    const err = new FakeEmailSendError('rate limited', { retryable: true, providerStatusCode: 429 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handleSendJob({ id: 'send-10', data: baseJobData } as never)).rejects.toBe(err);
  });

  it('swallows a terminal (non-retryable) EmailSendError without throwing', async () => {
    const err = new FakeEmailSendError('bad recipient', { retryable: false, providerStatusCode: 422 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handleSendJob({ id: 'send-11', data: baseJobData } as never)).resolves.toBeUndefined();
  });
});
