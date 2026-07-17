import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCookiesGet = vi.fn();
const mockCookiesToString = vi.fn();
const mockRedirect = vi.fn();
const mockApiServer = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => mockCookiesGet(name),
    toString: () => mockCookiesToString(),
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error('NEXT_REDIRECT');
  },
}));

vi.mock('@/lib/api-server', () => ({
  apiServer: (...args: unknown[]) => mockApiServer(...args),
}));

vi.mock('./AlertRules', () => ({
  default: () => null,
}));

const { default: AlertRulesPage } = await import('./page');

interface RscNode {
  props: { initial: unknown[] };
}

beforeEach(() => {
  mockCookiesGet.mockReset();
  mockCookiesToString.mockReset();
  mockRedirect.mockReset();
  mockApiServer.mockReset();
});

describe('AlertRulesPage (RSC)', () => {
  it('redirects to /login?next=/settings/alerts when access-token cookie is missing', async () => {
    mockCookiesGet.mockReturnValueOnce(undefined);

    await expect(AlertRulesPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/login?next=/settings/alerts');
    expect(mockApiServer).not.toHaveBeenCalled();
  });

  it('renders with server-fetched rules when the cookie is present', async () => {
    mockCookiesGet.mockReturnValueOnce({ value: 'jwt-abc' });
    mockCookiesToString.mockReturnValueOnce('access_token=jwt-abc');
    mockApiServer.mockResolvedValueOnce({
      data: [{ id: 1, kind: 'runway_runs_short', threshold: { months: 3 }, enabled: true, muteUntil: null, createdAt: '2026-07-01T00:00:00.000Z' }],
    });

    const tree = (await AlertRulesPage()) as unknown as RscNode;

    expect(mockApiServer).toHaveBeenCalledWith(
      '/org/alert-rules',
      expect.objectContaining({ cookies: 'access_token=jwt-abc' }),
    );
    expect(tree.props.initial).toHaveLength(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('falls through to an empty list when the upstream fetch throws', async () => {
    mockCookiesGet.mockReturnValueOnce({ value: 'jwt-abc' });
    mockCookiesToString.mockReturnValueOnce('access_token=jwt-abc');
    mockApiServer.mockRejectedValueOnce(new Error('upstream 502'));

    const tree = (await AlertRulesPage()) as unknown as RscNode;

    expect(tree.props.initial).toEqual([]);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
