import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// No test file existed, and dropping encodeURIComponent(statId) was green on the
// full web suite. The route's own comment names the failure: Next decodes both
// path segments, so a category containing a slash arrives literal, and forwarding
// it unencoded splits the upstream request line into extra segments.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { GET } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function req() {
  return new NextRequest('http://localhost/api/ai-summaries/1/stats/x', {
    headers: { cookie: 'access_token=abc' },
  });
}

function ok(body: unknown = { data: {} }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => fetchMock.mockReset());

describe('GET /api/ai-summaries/[datasetId]/stats/[statId]', () => {
  it('forwards to the internal API with the cookie', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { value: 1 } }));

    const res = await GET(req(), { params: Promise.resolve({ datasetId: '7', statId: 'total' }) });

    expect(await res.json()).toEqual({ data: { value: 1 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api:3001/ai-summaries/7/stats/total');
    expect(init.headers).toMatchObject({ cookie: 'access_token=abc' });
  });

  // A stat id derived from a category name can carry any character the user
  // typed. Unencoded, "Travel/Meals" becomes two path segments and the upstream
  // route stops matching.
  it.each([
    ['a slash', 'Travel/Meals', 'Travel%2FMeals'],
    ['a question mark', 'Rent?', 'Rent%3F'],
    ['a hash', 'A#1', 'A%231'],
    ['a space', 'Office Supplies', 'Office%20Supplies'],
  ])('encodes %s in the stat id', async (_label, statId, encoded) => {
    fetchMock.mockResolvedValueOnce(ok());

    await GET(req(), { params: Promise.resolve({ datasetId: '7', statId }) });

    expect(fetchMock.mock.calls[0]![0]).toBe(`http://api:3001/ai-summaries/7/stats/${encoded}`);
  });

  it('encodes the dataset id too', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await GET(req(), { params: Promise.resolve({ datasetId: 'a/b', statId: 'total' }) });

    expect(fetchMock.mock.calls[0]![0]).toBe('http://api:3001/ai-summaries/a%2Fb/stats/total');
  });

  it('reports the API unreachable rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await GET(req(), { params: Promise.resolve({ datasetId: '7', statId: 'total' }) });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'UPSTREAM_UNREACHABLE' } });
  });
});
