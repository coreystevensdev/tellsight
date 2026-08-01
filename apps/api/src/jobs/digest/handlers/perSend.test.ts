import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsertDefaults = vi.fn();
const mockMarkSent = vi.fn().mockResolvedValue(undefined);
const mockGetById = vi.fn();
const mockSendEmail = vi.fn();
const mockTrackEvent = vi.fn();

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

vi.mock('bullmq', () => ({
  Queue: class { constructor(public name: string, public opts: unknown) {} },
}));

vi.mock('../../../config.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'https://app.tellsight.com',
    PUBLIC_API_URL: 'https://api.tellsight.com',
    JWT_SECRET: 'a'.repeat(64),
    EMAIL_MAILING_ADDRESS: '1 Real St, Anywhere',
    EMAIL_FROM_ADDRESS: 'digest@tellsight.test',
    EMAIL_FROM_NAME: 'Tellsight',
  },
}));

const mockSetTag = vi.fn();
const mockWithScope = vi.fn(async (cb: (scope: { setTag: typeof mockSetTag }) => unknown) =>
  cb({ setTag: mockSetTag }),
);

vi.mock('../../../lib/sentry.js', () => ({
  Sentry: { withScope: mockWithScope },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../lib/db.js', () => ({
  dbAdmin: { __admin: true },
}));

vi.mock('../../../db/queries/index.js', () => ({
  digestPreferencesQueries: {
    upsertDefaults: mockUpsertDefaults,
    markSent: mockMarkSent,
  },
  aiSummariesQueries: {
    getById: mockGetById,
  },
}));

vi.mock('../../../services/email/index.js', () => ({
  sendEmail: mockSendEmail,
  EmailSendError: FakeEmailSendError,
}));

vi.mock('../../../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

// Capture DigestWeekly props directly. The component's return is a React tree
// whose root is <html>, props don't surface on the rendered element. Mocking
// the module lets the test assert what was passed in without parsing HTML.
const mockDigestWeekly = vi.fn((_props: unknown) => ({ __renderedDigest: true }));
vi.mock('../templates/digestWeekly.js', async () => {
  const actual = await vi.importActual<typeof import('../templates/digestWeekly.js')>(
    '../templates/digestWeekly.js',
  );
  return {
    ...actual,
    DigestWeekly: (props: unknown) => mockDigestWeekly(props),
  };
});

const { handlePerSendJob } = await import('./perSend.js');

const baseJobData = {
  userId: 7,
  orgId: 42,
  summaryId: 999,
  weekStart: new Date('2026-05-03T00:00:00Z'),
  userEmail: 'alice@example.com',
  orgName: 'Acme Coffee',
  subjectLine: 'Your runway needs attention - Acme Coffee weekly insights',
  correlationId: 'corr-abc',
};

const okSummary = {
  id: 999,
  orgId: 42,
  datasetId: 100,
  content: '- Revenue up\n- Payroll spiked\n- Runway 8 months',
  audience: 'digest-weekly',
  weekStart: new Date('2026-05-03T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('happy path', () => {
  it('sends email, marks sent, emits digest_sent', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-123',
      durationMs: 200,
    });

    await handlePerSendJob({ id: 'send-1', data: baseJobData } as never);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: baseJobData.subjectLine,
        tags: expect.objectContaining({
          template: 'digest-weekly-v1',
          org_id: '42',
          user_id: '7',
        }),
        correlationId: 'corr-abc',
      }),
    );
    expect(mockMarkSent).toHaveBeenCalledWith(7, expect.any(Date), { __admin: true });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42,
      7,
      'digest.sent',
      expect.objectContaining({
        templateVersion: 'digest-weekly-v1',
        summaryId: 999,
        providerMessageId: 'msg-123',
      }),
    );
  });

  it('sends whatever subjectLine the job carries, not a hardcoded template', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-subject',
      durationMs: 10,
    });

    const distinctJobData = { ...baseJobData, subjectLine: 'Your cash flow just flipped negative - Acme Coffee weekly insights' };
    await handlePerSendJob({ id: 'send-subject', data: distinctJobData } as never);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: distinctJobData.subjectLine }),
    );
  });

  it('attaches a URL-only List-Unsubscribe header (RFC 8058) derived from the unsubscribe URL', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-h',
      durationMs: 10,
    });

    await handlePerSendJob({ id: 'send-h', data: baseJobData } as never);

    const opts = mockSendEmail.mock.calls[0]![0] as {
      headers?: Record<string, string>;
    };
    expect(opts.headers).toBeDefined();
    expect(opts.headers!['List-Unsubscribe']).toMatch(
      /^<https:\/\/app\.tellsight\.com\/unsubscribe\/digest\/.+>$/,
    );
    expect(opts.headers!['List-Unsubscribe']).not.toContain('mailto:');
    expect(opts.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('wraps the per-send body in Sentry.withScope with org/user/template/week tags', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-scope',
      durationMs: 10,
    });

    await handlePerSendJob({ id: 'send-scope', data: baseJobData } as never);

    expect(mockWithScope).toHaveBeenCalledTimes(1);
    expect(mockSetTag).toHaveBeenCalledWith('org_id', '42');
    expect(mockSetTag).toHaveBeenCalledWith('user_id', '7');
    expect(mockSetTag).toHaveBeenCalledWith('template_version', 'digest-weekly-v1');
    expect(mockSetTag).toHaveBeenCalledWith('week_start', '2026-05-03T00:00:00.000Z');
  });

  it('signs a tracking token and threads it through the open URL + dashboard CTA', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-token',
      durationMs: 10,
    });

    await handlePerSendJob({ id: 'send-token', data: baseJobData } as never);

    expect(mockDigestWeekly).toHaveBeenCalledTimes(1);
    const props = mockDigestWeekly.mock.calls[0]![0] as {
      openTrackingUrl: string;
      dashboardUrl: string;
    };

    expect(props.openTrackingUrl).toMatch(/^https:\/\/api\.tellsight\.com\/track\/digest\/open\?t=.+/);
    expect(props.dashboardUrl).toContain('utm_source=digest');
    expect(props.dashboardUrl).toMatch(/[?&]t=[^&]+/);

    // Same token in both places, recoverable on click and on open
    const tokenFromOpen = new URL(props.openTrackingUrl).searchParams.get('t');
    const tokenFromCta = new URL(props.dashboardUrl).searchParams.get('t');
    expect(tokenFromOpen).toBeTruthy();
    expect(tokenFromOpen).toBe(tokenFromCta);
  });

  it('logs canSpamElements with all four CAN-SPAM fields on success', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({
      status: 'sent',
      providerMessageId: 'msg-audit',
      durationMs: 10,
    });

    const { logger } = await import('../../../lib/logger.js');
    await handlePerSendJob({ id: 'send-audit', data: baseJobData } as never);

    const successCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[1] === 'Per-send complete',
    );
    expect(successCall).toBeDefined();
    const payload = successCall![0] as {
      canSpamElements: {
        mailingAddress: string;
        unsubscribeUrl: string;
        recipientExplanation: string;
        companyName: string;
      };
    };
    expect(payload.canSpamElements.mailingAddress).toBe('1 Real St, Anywhere');
    expect(payload.canSpamElements.unsubscribeUrl).toMatch(
      /^https:\/\/app\.tellsight\.com\/unsubscribe\/digest\//,
    );
    expect(payload.canSpamElements.recipientExplanation).toBe(
      "You're receiving this because you're a Pro subscriber at Acme Coffee",
    );
    expect(payload.canSpamElements.companyName).toBe('Tellsight');
  });
});

describe('agent bullet fold-in', () => {
  it('appends agentBullets after the parsed summary bullets', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg-agent', durationMs: 10 });

    const jobData = { ...baseJobData, agentBullets: ['Marketing spend up: Review recent spend.'] };
    await handlePerSendJob({ id: 'send-agent-1', data: jobData } as never);

    const props = mockDigestWeekly.mock.calls[0]![0] as { bullets: string[] };
    expect(props.bullets).toEqual([
      'Revenue up',
      'Payroll spiked',
      'Runway 8 months',
      'Marketing spend up: Review recent spend.',
    ]);
  });

  it('falls back to the parsed summary bullets alone when agentBullets is absent', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg-agent-2', durationMs: 10 });

    await handlePerSendJob({ id: 'send-agent-2', data: baseJobData } as never);

    const props = mockDigestWeekly.mock.calls[0]![0] as { bullets: string[] };
    expect(props.bullets).toEqual(['Revenue up', 'Payroll spiked', 'Runway 8 months']);
  });
});

describe('per-user dedupe race', () => {
  it('skips when last_sent_at is within 6 days', async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: recent });

    await handlePerSendJob({ id: 'send-2', data: baseJobData } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42,
      7,
      'digest.skipped',
      expect.objectContaining({ reason: 'within_dedupe_window' }),
    );
  });

  it('proceeds when last_sent_at is older than 6 days', async () => {
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: old });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg', durationMs: 50 });

    await handlePerSendJob({ id: 'send-3', data: baseJobData } as never);

    expect(mockSendEmail).toHaveBeenCalled();
  });
});

describe('cadence safeguard', () => {
  it('skips when cadence is off (race after fan-out)', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'off', lastSentAt: null });

    await handlePerSendJob({ id: 'send-4', data: baseJobData } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42, 7, 'digest.skipped',
      expect.objectContaining({ reason: 'cadence_off' }),
    );
  });
});

describe('summary missing', () => {
  it('emits digest_failed when the cached summary cannot be loaded', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(undefined);

    await handlePerSendJob({ id: 'send-5', data: baseJobData } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42, 7, 'digest.failed',
      expect.objectContaining({ reason: 'summary_missing', summaryId: 999 }),
    );
  });
});

describe('invalid job payload', () => {
  it('skips and logs a warning when userEmail is missing', async () => {
    const { logger } = await import('../../../lib/logger.js');
    const dataWithoutEmail = { ...baseJobData } as Record<string, unknown>;
    delete dataWithoutEmail.userEmail;

    await handlePerSendJob({ id: 'send-bad-1', data: dataWithoutEmail } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-abc', jobId: 'send-bad-1' }),
      'invalid job payload, skipping',
    );
  });

  it('skips and logs a warning when orgId is the wrong type', async () => {
    const { logger } = await import('../../../lib/logger.js');
    const data = { ...baseJobData, orgId: '42' };

    await handlePerSendJob({ id: 'send-bad-2', data } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'send-bad-2' }),
      'invalid job payload, skipping',
    );
  });
});

describe('subjectLine fallback', () => {
  it('falls back to the default subject and still sends when subjectLine is missing', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg-fb-1', durationMs: 10 });
    const { logger } = await import('../../../lib/logger.js');
    const dataWithoutSubject = { ...baseJobData } as Record<string, unknown>;
    delete dataWithoutSubject.subjectLine;

    await handlePerSendJob({ id: 'send-fallback-1', data: dataWithoutSubject } as never);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Your weekly digest' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-abc', userId: 7, orgId: 42, jobId: 'send-fallback-1' }),
      'Digest subjectLine missing or blank, falling back to default subject',
    );
  });

  it('falls back to the default subject when subjectLine is whitespace-only', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg-fb-2', durationMs: 10 });
    const data = { ...baseJobData, subjectLine: '   ' };

    await handlePerSendJob({ id: 'send-fallback-2', data } as never);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Your weekly digest' }),
    );
  });
});

describe('failure semantics', () => {
  it('re-throws retryable failures so BullMQ retries (no markSent, no analytics)', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    const err = new FakeEmailSendError('rate limited', { retryable: true, providerStatusCode: 429 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handlePerSendJob({ id: 'send-6', data: baseJobData } as never)).rejects.toBe(err);

    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      42, 7, 'digest.sent', expect.anything(),
    );
  });

  it('terminal failures emit digest_failed, do not throw, do not mark sent', async () => {
    mockUpsertDefaults.mockResolvedValueOnce({ userId: 7, cadence: 'weekly', lastSentAt: null });
    mockGetById.mockResolvedValueOnce(okSummary);
    const err = new FakeEmailSendError('bad recipient', { retryable: false, providerStatusCode: 422 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handlePerSendJob({ id: 'send-7', data: baseJobData } as never)).resolves.toBeUndefined();

    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42, 7, 'digest.failed',
      expect.objectContaining({
        reason: 'send_failed',
        message: 'bad recipient',
        providerStatusCode: 422,
      }),
    );
  });
});
