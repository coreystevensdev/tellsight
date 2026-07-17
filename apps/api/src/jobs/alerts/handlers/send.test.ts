import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendEmail = vi.fn();

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
  env: { APP_URL: 'https://app.tellsight.test' },
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

const { handleSendJob } = await import('./send.js');

const baseJobData = {
  orgId: 42,
  orgName: 'Acme Coffee',
  userEmail: 'owner@acme.test',
  datasetId: 100,
  ruleId: 1,
  ruleKind: 'runway_runs_short',
  fireId: 999,
  currentValue: 1.5,
  trigger: 'cron',
  correlationId: 'corr-123',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleSendJob', () => {
  it('sends a plaintext email with the dashboard link and rule details', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'captured', providerMessageId: 'msg-1', durationMs: 5 });

    await handleSendJob({ id: 'send-1', data: baseJobData } as never);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.to).toBe('owner@acme.test');
    expect(call.subject).toContain('runway');
    expect(call.tags).toMatchObject({ org_id: '42', rule_id: '1' });
  });

  it('tags the Sentry scope with org, rule, and template version', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'captured', providerMessageId: 'msg-1', durationMs: 5 });

    await handleSendJob({ id: 'send-2', data: baseJobData } as never);

    expect(mockSetTag).toHaveBeenCalledWith('org_id', '42');
    expect(mockSetTag).toHaveBeenCalledWith('rule_id', '1');
    expect(mockSetTag).toHaveBeenCalledWith('rule_kind', 'runway_runs_short');
  });

  it('re-throws a retryable EmailSendError so BullMQ retries', async () => {
    const err = new FakeEmailSendError('rate limited', { retryable: true, providerStatusCode: 429 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handleSendJob({ id: 'send-3', data: baseJobData } as never)).rejects.toBe(err);
  });

  it('swallows a terminal (non-retryable) EmailSendError without throwing', async () => {
    const err = new FakeEmailSendError('bad recipient', { retryable: false, providerStatusCode: 422 });
    mockSendEmail.mockRejectedValueOnce(err);

    await expect(handleSendJob({ id: 'send-4', data: baseJobData } as never)).resolves.toBeUndefined();
  });
});
