import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockMuteViaToken = vi.fn();
const mockUnmuteViaToken = vi.fn();
const mockFindOrgById = vi.fn();
const mockRecordEvent = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  alertRulesQueries: {
    muteViaToken: mockMuteViaToken,
    unmuteViaToken: mockUnmuteViaToken,
  },
  orgsQueries: {
    findOrgById: mockFindOrgById,
  },
  analyticsEventsQueries: {
    recordEvent: mockRecordEvent,
  },
}));

vi.mock('../lib/db.js', () => ({
  dbAdmin: { __admin: true },
}));

vi.mock('../config.js', () => ({
  env: { JWT_SECRET: 'a'.repeat(64), NODE_ENV: 'test' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { signMuteToken } = await import('../jobs/alerts/muteToken.js');
const { publicAlertMuteRouter } = await import('./alertMute.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(publicAlertMuteRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordEvent.mockResolvedValue(undefined);
});

const mutedRule = {
  id: 1,
  orgId: 10,
  createdByUserId: 5,
  kind: 'runway_runs_short' as const,
  threshold: { months: 3 },
  enabled: true,
  muteUntil: new Date('2026-08-17T00:00:00.000Z'),
  deletedAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-18T00:00:00.000Z'),
};

describe('POST /alerts/mute/:token', () => {
  it('mutes the rule and returns the new mute date on a valid token', async () => {
    mockMuteViaToken.mockResolvedValueOnce(mutedRule);
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Coffee' });

    const token = signMuteToken(1);
    const res = await fetch(`${baseUrl}/alerts/mute/${encodeURIComponent(token)}`, { method: 'POST' });
    const json = (await res.json()) as { data: { muted: boolean; muteUntil: string; ruleKindLabel: string; orgName: string } };

    expect(res.status).toBe(200);
    expect(mockMuteViaToken).toHaveBeenCalledWith(1, { __admin: true });
    expect(json.data).toEqual({
      muted: true,
      muteUntil: '2026-08-17T00:00:00.000Z',
      ruleKindLabel: 'cash runway',
      orgName: 'Acme Coffee',
    });
  });

  it('records ALERT_MUTED with the org and creator, not a null userId', async () => {
    mockMuteViaToken.mockResolvedValueOnce(mutedRule);
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Coffee' });

    const token = signMuteToken(1);
    await fetch(`${baseUrl}/alerts/mute/${encodeURIComponent(token)}`, { method: 'POST' });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      10,
      5,
      'alert.muted',
      { muteUntil: mutedRule.muteUntil },
      { __admin: true },
    );
  });

  it('extends the mute window on a repeat click rather than stacking it', async () => {
    // muteViaToken always resets to +30d from the click, proven at the query
    // layer; here we only need to confirm the route surfaces whatever that
    // layer returns without re-deriving the date itself.
    const laterMute = { ...mutedRule, muteUntil: new Date('2026-09-01T00:00:00.000Z') };
    mockMuteViaToken.mockResolvedValueOnce(laterMute);
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Coffee' });

    const token = signMuteToken(1);
    const res = await fetch(`${baseUrl}/alerts/mute/${encodeURIComponent(token)}`, { method: 'POST' });
    const json = (await res.json()) as { data: { muteUntil: string } };

    expect(json.data.muteUntil).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns 400 INVALID_TOKEN on a tampered token, with no DB write', async () => {
    const res = await fetch(`${baseUrl}/alerts/mute/not-a-real-token`, { method: 'POST' });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_TOKEN');
    expect(mockMuteViaToken).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_TOKEN when the rule is soft-deleted (query returns no row)', async () => {
    mockMuteViaToken.mockResolvedValueOnce(null);

    const token = signMuteToken(1);
    const res = await fetch(`${baseUrl}/alerts/mute/${encodeURIComponent(token)}`, { method: 'POST' });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_TOKEN');
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('POST /alerts/unmute/:token', () => {
  it('unmutes the rule and records ALERT_UNMUTED', async () => {
    const unmutedRule = { ...mutedRule, muteUntil: null };
    mockUnmuteViaToken.mockResolvedValueOnce(unmutedRule);
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Coffee' });

    const token = signMuteToken(1);
    const res = await fetch(`${baseUrl}/alerts/unmute/${encodeURIComponent(token)}`, { method: 'POST' });
    const json = (await res.json()) as { data: { muted: boolean; muteUntil: string | null } };

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      muted: false,
      muteUntil: null,
      ruleKindLabel: 'cash runway',
      orgName: 'Acme Coffee',
    });
    expect(mockRecordEvent).toHaveBeenCalledWith(10, 5, 'alert.unmuted', { muteUntil: null }, { __admin: true });
  });

  it('returns 400 INVALID_TOKEN on an invalid token', async () => {
    const res = await fetch(`${baseUrl}/alerts/unmute/garbage`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(mockUnmuteViaToken).not.toHaveBeenCalled();
  });
});
