// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// No test file. Swapping the ternary so authenticated users fetch the public
// seed /cached endpoint and anonymous visitors fetch the protected /latest left
// the whole web suite green. Four bare catch blocks turn any API failure into a
// silent default, all of them uncovered.

const apiServer = vi.fn();
class ApiServerError extends Error {
  constructor(public code: string, message: string, public statusCode: number) {
    super(message);
  }
}
vi.mock('@/lib/api-server', () => ({
  apiServer: (...a: unknown[]) => apiServer(...a),
  ApiServerError,
}));

const cookieJar = { entries: [] as Array<{ name: string; value: string }> };
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => cookieJar.entries,
    has: (name: string) => cookieJar.entries.some((c) => c.name === name),
  }),
}));

// Mocked only so importing the page does not pull in the client component
// tree. The props are read off the returned element rather than by rendering:
// awaiting an async Server Component hands back the element, it does not invoke
// the child, so a spy inside the mock would never fire.
vi.mock('./DashboardShell', () => ({ DashboardShell: () => null }));

const { default: DashboardPage } = await import('./page');

const CHARTS = { datasetId: 7, revenueTrend: [], expenseBreakdown: [] };

function signedIn() {
  cookieJar.entries = [
    { name: 'access_token', value: 'jwt' },
    { name: 'refresh_token', value: 'refresh' },
  ];
}

function anonymous() {
  cookieJar.entries = [];
}

/** Routes each path to a canned answer; anything unlisted rejects. */
function respond(map: Record<string, unknown>) {
  apiServer.mockImplementation(async (path: string) => {
    for (const [key, value] of Object.entries(map)) {
      if (String(path).includes(key)) {
        if (value instanceof Error) throw value;
        return { data: value };
      }
    }
    throw new ApiServerError('NOT_FOUND', 'no route', 404);
  });
}

async function renderPage() {
  const element = (await DashboardPage()) as { props: Record<string, unknown> };
  return element.props;
}

beforeEach(() => {
  apiServer.mockReset();
  anonymous();
});

describe('DashboardPage summary source', () => {
  // /cached is the public seed-org endpoint and /latest is the protected
  // per-user one. Crossing them shows an anonymous visitor nothing and shows a
  // signed-in user the demo org's summary as though it were their own.
  it('reads the public cached summary for an anonymous visitor', async () => {
    respond({ '/dashboard/charts': CHARTS, '/cached': { content: 'seed summary', metadata: null } });

    const props = await renderPage();

    expect(props.cachedSummary).toBe('seed summary');
    const paths = apiServer.mock.calls.map(([p]) => String(p));
    expect(paths.some((p) => p.includes('/cached'))).toBe(true);
    expect(paths.some((p) => p.includes('/latest'))).toBe(false);
  });

  it('reads the protected latest summary for a signed-in user', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'your summary', metadata: null },
      '/subscriptions/tier': { tier: 'pro' },
      '/org/profile': {},
    });

    const props = await renderPage();

    expect(props.cachedSummary).toBe('your summary');
    const paths = apiServer.mock.calls.map(([p]) => String(p));
    expect(paths.some((p) => p.includes('/latest'))).toBe(true);
    expect(paths.some((p) => p.includes('/cached'))).toBe(false);
  });

  it('asks for no summary at all when there is no dataset', async () => {
    respond({ '/dashboard/charts': { ...CHARTS, datasetId: null } });

    const props = await renderPage();

    expect(props.cachedSummary).toBeUndefined();
    const paths = apiServer.mock.calls.map(([p]) => String(p));
    expect(paths.some((p) => p.includes('/cached') || p.includes('/latest'))).toBe(false);
  });

  // Stale means the data moved on after the summary was written. The card
  // renders a refresh banner instead of silently streaming, so the flag has to
  // reach it.
  it('passes the stale timestamp through to the shell', async () => {
    respond({
      '/dashboard/charts': CHARTS,
      '/cached': { content: 'old', metadata: null, staleAt: '2026-09-01T00:00:00Z' },
    });

    expect((await renderPage()).cachedStaleAt).toBe('2026-09-01T00:00:00Z');
  });
});

describe('DashboardPage tier and onboarding', () => {
  // Undefined rather than 'free': an anonymous visitor has no tier, and calling
  // a protected endpoint for one would just 401.
  it('requests no tier for an anonymous visitor', async () => {
    respond({ '/dashboard/charts': CHARTS, '/cached': { content: 'x', metadata: null } });

    const props = await renderPage();

    expect(props.tier).toBeUndefined();
    expect(apiServer.mock.calls.some(([p]) => String(p).includes('/subscriptions/tier'))).toBe(false);
  });

  it('resolves the tier for a signed-in user', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'x', metadata: null },
      '/subscriptions/tier': { tier: 'pro' },
      '/org/profile': {},
    });

    expect((await renderPage()).tier).toBe('pro');
  });

  // Failing closed to 'free' is the safe direction: a tier lookup that errors
  // must not hand out Pro.
  it('falls back to free when the tier lookup fails', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'x', metadata: null },
      '/subscriptions/tier': new ApiServerError('BOOM', 'down', 500),
      '/org/profile': {},
    });

    expect((await renderPage()).tier).toBe('free');
  });

  // A null profile is the signal the user has never onboarded. Anything else,
  // including a failed lookup, must not put the modal in front of them.
  it('asks for onboarding only when the profile is null', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'x', metadata: null },
      '/subscriptions/tier': { tier: 'free' },
      '/org/profile': null,
    });

    expect((await renderPage()).needsOnboarding).toBe(true);
  });

  it('does not ask for onboarding when the profile lookup fails', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'x', metadata: null },
      '/subscriptions/tier': { tier: 'free' },
      '/org/profile': new ApiServerError('BOOM', 'down', 500),
    });

    expect((await renderPage()).needsOnboarding).toBe(false);
  });
});

describe('DashboardPage chart failures', () => {
  // An API failure renders an empty dashboard rather than an error page: the
  // page is public and a visitor with no data should still see the shell.
  it('renders empty chart data when the charts call fails', async () => {
    respond({ '/dashboard/charts': new ApiServerError('BOOM', 'down', 500) });

    const props = await renderPage();

    expect(props.initialData).toMatchObject({ datasetId: null });
  });

  // Anything that is not an ApiServerError is a bug rather than an upstream
  // failure, and swallowing it would hide it behind an empty dashboard.
  it('rethrows a non-API error rather than blanking the page', async () => {
    apiServer.mockRejectedValueOnce(new TypeError('undefined is not a function'));

    await expect(DashboardPage()).rejects.toThrow(TypeError);
  });
});
