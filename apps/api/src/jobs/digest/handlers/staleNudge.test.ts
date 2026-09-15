import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindRecipients = vi.fn();
const mockMarkStaleNudgeSent = vi.fn().mockResolvedValue(undefined);
const mockSendEmail = vi.fn();
const mockTrackEvent = vi.fn();

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

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../lib/db.js', () => ({ dbAdmin: { __admin: true } }));

vi.mock('../../../db/queries/index.js', () => ({
  digestEligibilityQueries: {
    findOrgNudgeRecipients: mockFindRecipients,
    markStaleNudgeSent: mockMarkStaleNudgeSent,
  },
}));

vi.mock('../../../services/email/index.js', () => ({
  sendEmail: mockSendEmail,
  EmailSendError: class extends Error {},
}));

vi.mock('../../../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

const { handleStaleNudgeJob } = await import('./staleNudge.js');

const STALE_SINCE = new Date('2026-08-01T00:00:00.000Z');

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nudge-1',
    data: {
      orgId: 42,
      orgName: 'Acme Landscaping',
      datasetCreatedAt: STALE_SINCE.toISOString(),
      correlationId: 'corr-1',
      ...overrides,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ status: 'sent', providerMessageId: 'msg-1', durationMs: 20 });
  mockMarkStaleNudgeSent.mockResolvedValue(undefined);
});

describe('stale nudge fan-out', () => {
  it('emails every opted-in member of the org', async () => {
    mockFindRecipients.mockResolvedValue([
      { userId: 1, email: 'a@example.com', name: 'A' },
      { userId: 2, email: 'b@example.com', name: 'B' },
    ]);

    await handleStaleNudgeJob(job());

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls.map(([o]) => o.to)).toEqual(['a@example.com', 'b@example.com']);
  });

  // Gmail and Yahoo's 2024 sender rules require one-click unsubscribe on bulk
  // mail, and this is bulk mail even though it is sent once.
  it('carries the one-click unsubscribe headers', async () => {
    mockFindRecipients.mockResolvedValue([{ userId: 1, email: 'a@example.com', name: 'A' }]);

    await handleStaleNudgeJob(job());

    const [opts] = mockSendEmail.mock.calls[0]!;
    expect(opts.headers['List-Unsubscribe']).toMatch(/^<https?:\/\//);
    expect(opts.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});

describe('stale nudge marking', () => {
  // The whole point of the column. Without the stamp the sweep re-selects this
  // org next week and the one-time notice becomes a weekly one, which is the
  // thing most likely to make someone unsubscribe outright.
  it('records the org as told once a send lands', async () => {
    mockFindRecipients.mockResolvedValue([{ userId: 1, email: 'a@example.com', name: 'A' }]);

    await handleStaleNudgeJob(job());

    expect(mockMarkStaleNudgeSent).toHaveBeenCalledWith(42, expect.any(Date));
  });

  // One permanently bouncing address must not re-send to everyone else week
  // after week. The column answers "has this org been told", and it has.
  it('records the org as told when only some sends land', async () => {
    mockFindRecipients.mockResolvedValue([
      { userId: 1, email: 'a@example.com', name: 'A' },
      { userId: 2, email: 'bounces@example.com', name: 'B' },
    ]);
    mockSendEmail
      .mockResolvedValueOnce({ status: 'sent', providerMessageId: 'msg-1', durationMs: 20 })
      .mockRejectedValueOnce(new Error('550 mailbox unavailable'));

    await handleStaleNudgeJob(job());

    expect(mockMarkStaleNudgeSent).toHaveBeenCalledTimes(1);
  });

  // Nobody was told, so the org has not been told. Leaving it unstamped is what
  // makes next week's sweep pick it up again.
  it('leaves the org unmarked when every send fails', async () => {
    mockFindRecipients.mockResolvedValue([{ userId: 1, email: 'a@example.com', name: 'A' }]);
    mockSendEmail.mockRejectedValue(new Error('provider down'));

    await handleStaleNudgeJob(job());

    expect(mockMarkStaleNudgeSent).not.toHaveBeenCalled();
  });

  // Everyone turned the digest off between the sweep and now. Stamping here
  // would suppress a real notice later, for an email that was never sent.
  it('leaves the org unmarked when there is nobody to tell', async () => {
    mockFindRecipients.mockResolvedValue([]);

    await handleStaleNudgeJob(job());

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockMarkStaleNudgeSent).not.toHaveBeenCalled();
  });
});

describe('stale nudge content', () => {
  // Deliberately half past a day boundary. An exact multiple would pass under
  // either rounding, so it would assert nothing about which one is used, and
  // rounding up here means telling someone their data is 46 days old on the day
  // it turns 45.
  it('counts whole elapsed days, rounding down', async () => {
    mockFindRecipients.mockResolvedValue([{ userId: 1, email: 'a@example.com', name: 'A' }]);
    vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));

    await handleStaleNudgeJob(job());

    // 2026-08-01T00:00 to 2026-09-15T12:00 is 45.5 days.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      42,
      1,
      'digest.paused_notice_sent',
      expect.objectContaining({ daysSinceData: 45 }),
    );
    vi.useRealTimers();
  });

  it('tags the send so provider-side reporting can separate it from the digest', async () => {
    mockFindRecipients.mockResolvedValue([{ userId: 1, email: 'a@example.com', name: 'A' }]);

    await handleStaleNudgeJob(job());

    const [opts] = mockSendEmail.mock.calls[0]!;
    expect(opts.tags).toMatchObject({ template: 'stale-nudge-v1', org_id: '42', user_id: '1' });
  });
});
