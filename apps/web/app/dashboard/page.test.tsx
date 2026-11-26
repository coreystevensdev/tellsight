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

  // A 401 means the API refused these cookies, so the fallback answer is the
  // seed org's and its datasetId is too. Asking the protected /latest for it
  // spends a refused cookie on another org's dataset and renders nothing.
  it('reads the public cached summary after the charts call falls back', async () => {
    signedIn();
    apiServer.mockImplementation(async (path: string, opts?: { cookies?: string }) => {
      const p = String(path);
      if (p.includes('/dashboard/charts')) {
        if (opts?.cookies) throw new ApiServerError('AUTHENTICATION_REQUIRED', 'Session expired', 401);
        return { data: { ...CHARTS, isDemo: true, orgName: 'Sunrise Cafe' } };
      }
      if (p.includes('/cached')) return { data: { content: 'seed summary', metadata: null } };
      throw new ApiServerError('NOT_FOUND', 'no route', 404);
    });

    const props = await renderPage();

    expect(props.cachedSummary).toBe('seed summary');
    const paths = apiServer.mock.calls.map(([p]) => String(p));
    expect(paths.some((p) => p.includes('/latest'))).toBe(false);
  });

  // The whole fan-out, because the summary route is only one of three calls the
  // cookie used to reach. tier catches to 'free', so a Pro org got free-tier
  // gating beside demo charts, which is the defect #434 fixed by another route.
  it('asks for neither tier nor profile after the charts call falls back', async () => {
    signedIn();
    apiServer.mockImplementation(async (path: string, opts?: { cookies?: string }) => {
      const p = String(path);
      if (p.includes('/dashboard/charts')) {
        if (opts?.cookies) throw new ApiServerError('AUTHENTICATION_REQUIRED', 'Session expired', 401);
        return { data: { ...CHARTS, isDemo: true } };
      }
      if (p.includes('/cached')) return { data: { content: 'seed', metadata: null } };
      throw new ApiServerError('NOT_FOUND', 'no route', 404);
    });

    const props = await renderPage();

    expect(apiServer.mock.calls.map(([p]) => String(p))).toEqual([
      '/dashboard/charts',
      '/dashboard/charts',
      '/ai-summaries/7/cached',
    ]);
    expect(props.tier).toBeUndefined();
    expect(props.needsOnboarding).toBe(false);
  });

  // The retry is for a 401 and nothing else. Widened to any ApiServerError it
  // doubles every failed render's spend against the public rate-limit budget,
  // and a 502-then-success render would come back marked servedAnonymously,
  // which silently shows a signed-in reader the demo. The it.each cases below
  // fail every charts call, so the retry failing lands on the same assertion
  // they already make and cannot tell the two apart.
  it('does not retry a 502, which is an upstream failure rather than a session', async () => {
    signedIn();
    const calls: (string | undefined)[] = [];
    apiServer.mockImplementation(async (path: string, opts?: { cookies?: string }) => {
      const p = String(path);
      if (!p.includes('/dashboard/charts')) throw new ApiServerError('NOT_FOUND', 'no route', 404);
      calls.push(opts?.cookies);
      if (calls.length === 1) throw new ApiServerError('UPSTREAM', 'bad gateway', 502);
      return { data: { ...CHARTS, isDemo: true } };
    });

    const props = await renderPage();

    expect(calls).toHaveLength(1);
    expect(props.chartsUnavailable).toBe(true);
    expect(props.initialData).toMatchObject({ demoState: 'empty' });
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

  // The API answers 401 when a refresh cookie is all that is left and the proxy
  // could not mint from it, a revoked token or a lost rotation race. The page is
  // public, so that visitor gets the demo, not an empty shell.
  it('asks again as a visitor when the charts call is refused as signed out', async () => {
    cookieJar.entries = [{ name: 'refresh_token', value: 'revoked' }];
    const chartCalls: (string | undefined)[] = [];
    apiServer.mockImplementation(async (path: string, opts?: { cookies?: string }) => {
      if (!String(path).includes('/dashboard/charts')) throw new ApiServerError('NOT_FOUND', 'no route', 404);
      chartCalls.push(opts?.cookies);
      if (opts?.cookies) throw new ApiServerError('AUTHENTICATION_REQUIRED', 'Session expired', 401);
      // orgName is the discriminator, not isDemo: EMPTY_CHART_DATA carries
      // isDemo true as well, so asserting it passes just as happily on the
      // catch path this test exists to rule out.
      return { data: { ...CHARTS, datasetId: null, isDemo: true, orgName: 'Sunrise Cafe' } };
    });

    const props = await renderPage();

    expect(props.initialData).toMatchObject({ isDemo: true, orgName: 'Sunrise Cafe' });
    expect(props.chartsUnavailable).toBe(false);
    // Two calls, and the retry carries no cookies. The fan-out suite below pins
    // an exact count for every other render and skipped this path, so the one
    // render that spends two points of the public budget was the unpinned one.
    expect(chartCalls).toEqual(['refresh_token=revoked', undefined]);
  });

  // Anything that is not an ApiServerError is a bug rather than an upstream
  // failure, and swallowing it would hide it behind an empty dashboard.
  it('rethrows a non-API error rather than blanking the page', async () => {
    apiServer.mockRejectedValueOnce(new TypeError('undefined is not a function'));

    await expect(DashboardPage()).rejects.toThrow(TypeError);
  });
});

describe('DashboardPage distinguishes a failure from an empty account', () => {
  // Measured against production on 2026-10-22: with the public bucket spent,
  // /dashboard answered 200 and rendered "No data yet. Upload a CSV...". The
  // reader is told their account is empty when the request simply failed, and
  // neither the page nor the status code says otherwise.
  it('flags a failed charts call so the empty-state banner stays hidden', async () => {
    respond({ '/dashboard/charts': new ApiServerError('RATE_LIMITED', 'Too many requests', 429) });

    const props = await renderPage();

    expect(props.chartsUnavailable).toBe(true);
  });

  it('does not flag a genuinely empty account', async () => {
    respond({ '/dashboard/charts': { ...CHARTS, datasetId: null, demoState: 'empty' } });

    const props = await renderPage();

    expect(props.chartsUnavailable).toBe(false);
  });

  // Every upstream status takes the same branch, so the fake empty state was
  // reachable from an outage or a timeout too, not only from throttling.
  it.each([429, 500, 502, 503])('flags a %s the same way', async (status) => {
    respond({ '/dashboard/charts': new ApiServerError('ERR', 'upstream', status) });

    const props = await renderPage();

    expect(props.chartsUnavailable).toBe(true);
  });
});

// Each call here spends a point of the visitor's public rate-limit budget, so
// this count and RATE_LIMITS.public together decide how many times someone can
// open the dashboard before it breaks. Exact rather than an upper bound: a
// `toBeLessThanOrEqual` written against the budget passed happily when a ninth
// fetch was added, because the real count had slack under the ceiling.
describe('DashboardPage request fan-out', () => {
  it('makes exactly four calls for a signed-in render', async () => {
    signedIn();
    respond({
      '/dashboard/charts': CHARTS,
      '/latest': { content: 'summary', metadata: null },
      '/subscriptions/tier': { tier: 'pro' },
      '/org/profile': { businessType: 'retail', teamSize: 'solo' },
    });

    await renderPage();

    expect(apiServer.mock.calls.map((c) => c[0])).toEqual([
      '/dashboard/charts',
      '/ai-summaries/7/latest',
      '/subscriptions/tier',
      '/org/profile',
    ]);
  });

  it('makes exactly two for an anonymous render', async () => {
    anonymous();
    respond({ '/dashboard/charts': CHARTS, '/cached': { content: 'seed', metadata: null } });

    await renderPage();

    expect(apiServer.mock.calls.map((c) => c[0])).toEqual([
      '/dashboard/charts',
      '/ai-summaries/7/cached',
    ]);
  });
});
