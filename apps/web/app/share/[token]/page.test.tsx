import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only SharedInsightCard.test.tsx sat next to this page; the page itself was
// untested. Two mutations were green on the full web suite: forcing the error
// variant to 'not-found' so every expired link rendered the wrong page, and
// dropping stripAllDisplayTags so raw <stat> markup reached social unfurls,
// which is the exact failure the comment above that line describes.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('@/components/common/TellsightLogo', () => ({
  TellsightLogo: () => <span>logo</span>,
}));

vi.mock('./SharedInsightCard', () => ({
  default: ({ orgName }: { orgName: string }) => <article>card for {orgName}</article>,
}));

vi.mock('./ShareError', () => ({
  default: ({ variant }: { variant: string }) => <div>error variant: {variant}</div>,
}));

const { default: SharePage, generateMetadata } = await import('./page');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function share(over: Record<string, unknown> = {}) {
  return {
    orgName: 'Acme Coffee',
    dateRange: 'Jan 2026',
    aiSummaryContent: 'Revenue rose sharply.',
    chartConfig: {},
    viewCount: 3,
    ...over,
  };
}

function upstream(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const params = Promise.resolve({ token: 'tok-1' });

beforeEach(() => fetchMock.mockReset());

describe('SharePage error variants', () => {
  // 410 Gone is what the API answers for a link that existed and expired. Any
  // other failure is a link that never existed, or a token that was tampered
  // with. Collapsing the two tells an expired-link visitor their link was never
  // real.
  it('renders the expired page for a 410', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ error: { message: 'gone' } }, 410));

    render(await SharePage({ params }));

    expect(screen.getByText(/error variant: expired/)).toBeInTheDocument();
  });

  it.each([404, 400, 401, 500])('renders the not-found page for a %s', async (status) => {
    fetchMock.mockResolvedValueOnce(upstream({ error: { message: 'nope' } }, status));

    render(await SharePage({ params }));

    expect(screen.getByText(/error variant: not-found/)).toBeInTheDocument();
  });

  it('renders not-found when the API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    render(await SharePage({ params }));

    expect(screen.getByText(/error variant: not-found/)).toBeInTheDocument();
  });

  it('renders the card when the share resolves', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: share() }));

    render(await SharePage({ params }));

    expect(screen.getByText(/card for Acme Coffee/)).toBeInTheDocument();
    expect(screen.queryByText(/error variant/)).not.toBeInTheDocument();
  });
});

describe('SharePage metadata', () => {
  it('falls back to a generic title when the share cannot be loaded', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ error: { message: 'gone' } }, 410));

    expect(await generateMetadata({ params })).toEqual({ title: 'Shared Insight, Tellsight' });
  });

  it('titles the page with the org name', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: share() }));

    expect((await generateMetadata({ params })).title).toBe('Acme Coffee, Business Insight');
  });

  // The whole reason the strip exists: a tag landing inside the truncation
  // window would otherwise be surfaced verbatim by Twitter, Facebook or iMessage.
  // Stat ids are StatType values, which are snake_case (cash_flow,
  // year_over_year, category_breakdown), and the tag regex is \w+ to match. A
  // hyphenated id is not something this system can emit, so the fixture uses
  // real ones rather than inventing a shape the strip was never meant to handle.
  it('strips display tags before they can reach a social unfurl', async () => {
    fetchMock.mockResolvedValueOnce(
      upstream({
        data: share({
          aiSummaryContent: 'Revenue <stat id="cash_flow"/> rose 20% against <stat id="year_over_year"/> last quarter.',
        }),
      }),
    );

    const meta = await generateMetadata({ params });
    const og = meta.openGraph as { title: string; description: string };

    expect(og.description).not.toContain('<stat');
    expect(og.description).not.toContain('id=');
    expect(og.title).not.toContain('<stat');
  });

  // 60 for the title, 150 for the description, both cut at a word boundary so
  // an unfurl never ends mid-word.
  it('truncates the title harder than the description, at a word boundary', async () => {
    const long = 'Revenue grew steadily across every category this quarter, with marketing spend holding flat and payroll rising modestly against a stable headcount.';
    fetchMock.mockResolvedValueOnce(upstream({ data: share({ aiSummaryContent: long }) }));

    const og = (await generateMetadata({ params })).openGraph as { title: string; description: string };

    expect(og.title.length).toBeLessThanOrEqual(60);
    expect(og.description.length).toBeLessThanOrEqual(150);
    expect(og.title.length).toBeLessThan(og.description.length);
    expect(og.title.endsWith(' ')).toBe(false);
    expect(long.startsWith(og.title)).toBe(true);
  });

  it('leaves a summary shorter than the window untouched', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: share({ aiSummaryContent: 'Short one.' }) }));

    const og = (await generateMetadata({ params })).openGraph as { title: string };

    expect(og.title).toBe('Short one.');
  });

  // No space inside the window means there is no boundary to cut at, so it falls
  // back to a hard slice rather than returning nothing.
  it('hard-slices a single unbroken word', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: share({ aiSummaryContent: 'x'.repeat(200) }) }));

    const og = (await generateMetadata({ params })).openGraph as { title: string };

    expect(og.title).toHaveLength(60);
  });
});
