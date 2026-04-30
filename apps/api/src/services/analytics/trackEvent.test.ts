import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordEvent = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  analyticsEventsQueries: {
    recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
  },
}));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {},
}));

const mockLogError = vi.fn();
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  },
}));

const { trackEvent } = await import('./trackEvent.js');

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe('trackEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordEvent.mockResolvedValue({ id: 1 });
  });

  it('calls recordEvent with the right args', async () => {
    trackEvent(10, 5, 'dataset.uploaded', { rows: 42 });
    await flushPromises();

    expect(mockRecordEvent).toHaveBeenCalledWith(10, 5, 'dataset.uploaded', { rows: 42 }, expect.anything());
  });

  it('passes undefined metadata as undefined', async () => {
    trackEvent(10, 5, 'user.signed_in');
    await flushPromises();

    expect(mockRecordEvent).toHaveBeenCalledWith(10, 5, 'user.signed_in', undefined, expect.anything());
  });

  it('does not throw when recordEvent fails, fire-and-forget', async () => {
    mockRecordEvent.mockRejectedValueOnce(new Error('db down'));

    // trackEvent returns void, should not throw
    expect(() => trackEvent(10, 5, 'dataset.uploaded')).not.toThrow();
    await flushPromises();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, userId: 5, eventName: 'dataset.uploaded' }),
      'Failed to record analytics event',
    );
  });

  it('logs structured error context on failure', async () => {
    const dbError = new Error('connection refused');
    mockRecordEvent.mockRejectedValueOnce(dbError);

    trackEvent(7, 3, 'org.created', { slug: 'acme' });
    await flushPromises();

    expect(mockLogError).toHaveBeenCalledOnce();
    const loggedObj = mockLogError.mock.calls[0]![0];
    expect(loggedObj.err).toBe(dbError);
    expect(loggedObj.orgId).toBe(7);
    expect(loggedObj.userId).toBe(3);
    expect(loggedObj.eventName).toBe('org.created');
  });
});
