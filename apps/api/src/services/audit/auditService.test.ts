import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecord = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  auditLogsQueries: {
    record: (...args: unknown[]) => mockRecord(...args),
  },
}));

const mockLogError = vi.fn();
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  },
}));

const { audit, auditAuth, auditSystem } = await import('./auditService.js');

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    ip: '192.168.1.42',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'Mozilla/5.0 TestBrowser' },
    ...overrides,
  } as never;
}

describe('audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue({ id: 1 });
  });

  it('records entry with IP and user-agent from request', async () => {
    audit(fakeReq(), {
      orgId: 10,
      userId: 5,
      action: 'auth.login',
    });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith({
      orgId: 10,
      userId: 5,
      action: 'auth.login',
      ipAddress: '192.168.1.42',
      userAgent: 'Mozilla/5.0 TestBrowser',
    });
  });

  it('falls back to socket.remoteAddress when req.ip is undefined', async () => {
    audit(fakeReq({ ip: undefined }), {
      orgId: 10,
      userId: 5,
      action: 'auth.logout',
    });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '127.0.0.1' }),
    );
  });

  it('includes target and metadata when provided', async () => {
    audit(fakeReq(), {
      orgId: 10,
      userId: 5,
      action: 'dataset.deleted',
      targetType: 'dataset',
      targetId: '42',
      metadata: { name: 'Q1 Sales', rowCount: 500 },
    });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'dataset',
        targetId: '42',
        metadata: { name: 'Q1 Sales', rowCount: 500 },
      }),
    );
  });

  it('does not throw when record fails, fire-and-forget', async () => {
    mockRecord.mockRejectedValueOnce(new Error('db down'));

    expect(() => audit(fakeReq(), { orgId: 1, userId: 1, action: 'test' })).not.toThrow();
    await flushPromises();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'test' }),
      'Failed to write audit log',
    );
  });
});

describe('auditAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue({ id: 1 });
  });

  it('extracts userId and orgId from JWT payload', async () => {
    const req = fakeReq({
      user: { sub: '7', org_id: 20, role: 'owner', isAdmin: false },
    });

    auditAuth(req, 'subscription.checkout');
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 20,
        userId: 7,
        action: 'subscription.checkout',
      }),
    );
  });

  it('passes extra target and metadata through', async () => {
    const req = fakeReq({
      user: { sub: '3', org_id: 10, role: 'member', isAdmin: false },
    });

    auditAuth(req, 'integration.disconnected', {
      targetType: 'integration',
      targetId: 'quickbooks',
      metadata: { reason: 'user-initiated' },
    });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'integration',
        targetId: 'quickbooks',
        metadata: { reason: 'user-initiated' },
      }),
    );
  });

  it('handles missing user gracefully', async () => {
    const req = fakeReq({ user: undefined });

    auditAuth(req, 'auth.login');
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null, userId: null }),
    );
  });
});

describe('auditSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue(undefined);
  });

  it('writes a system audit entry with no IP or user-agent', async () => {
    auditSystem({
      orgId: 7,
      userId: 99,
      action: 'subscription.cancelled',
      targetType: 'subscription',
      targetId: 'sub_abc123',
      metadata: { currentPeriodEnd: '2026-05-01T00:00:00.000Z' },
    });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith({
      orgId: 7,
      userId: 99,
      action: 'subscription.cancelled',
      targetType: 'subscription',
      targetId: 'sub_abc123',
      metadata: { currentPeriodEnd: '2026-05-01T00:00:00.000Z' },
    });
  });

  it('accepts null userId (system-initiated events without a known actor)', async () => {
    auditSystem({ orgId: 7, userId: null, action: 'subscription.cancelled' });
    await flushPromises();

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 7, userId: null }),
    );
  });

  it('never throws on DB failure, logs error and moves on', async () => {
    mockRecord.mockRejectedValueOnce(new Error('DB down'));

    expect(() =>
      auditSystem({ orgId: 7, userId: null, action: 'subscription.cancelled' }),
    ).not.toThrow();

    await flushPromises();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.cancelled' }),
      'Failed to write system audit log',
    );
  });
});
