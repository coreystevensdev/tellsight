import type { Metadata } from 'next';
import { stripAllStatTags } from 'shared/constants';
import { webEnv } from '@/lib/config';
import SharedInsightCard from './SharedInsightCard';
import ShareError from './ShareError';

interface ShareData {
  orgName: string;
  dateRange: string;
  aiSummaryContent: string;
  chartConfig: Record<string, unknown>;
  viewCount: number;
}

type FetchResult =
  | { ok: true; data: ShareData }
  | { ok: false; status: number; message: string };

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastSpace = text.lastIndexOf(' ', max);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max);
}

// Next.js request memoization deduplicates this across generateMetadata + page component
async function fetchShare(token: string): Promise<FetchResult> {
  try {
    const res = await fetch(`${webEnv.API_INTERNAL_URL}/shares/${token}`, {
      cache: 'no-store',
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = body?.error?.message ?? 'Share not found';
      return { ok: false, status: res.status, message };
    }

    const { data } = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, status: 500, message: 'Unable to load shared insight' };
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const result = await fetchShare(token);

  if (!result.ok) {
    return { title: 'Shared Insight — Tellsight' };
  }

  const { orgName, aiSummaryContent } = result.data;
  // strip <stat id="..."/> tokens before truncation — otherwise social
  // unfurls (Twitter/Facebook/iMessage) surface raw markup when a tag
  // lands inside the truncation window
  const cleanContent = stripAllStatTags(aiSummaryContent);
  const ogTitle = truncateAtWord(cleanContent, 60);
  const description = truncateAtWord(cleanContent, 150);

  return {
    title: `${orgName} — Business Insight`,
    openGraph: {
      title: ogTitle,
      description,
      type: 'article',
      siteName: 'Tellsight',
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchShare(token);

  if (!result.ok) {
    const variant = result.status === 410 ? 'expired' : 'not-found';
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <div className="px-4 py-4 text-sm font-medium text-muted-foreground">
          Tellsight
        </div>
        <div className="flex flex-1 items-center justify-center">
          <ShareError variant={variant} />
        </div>
      </div>
    );
  }

  const { orgName, dateRange, aiSummaryContent } = result.data;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="px-4 py-4 text-sm font-medium text-muted-foreground">
        Tellsight
      </div>
      <div className="flex flex-1 items-center justify-center px-4">
        <SharedInsightCard
          orgName={orgName}
          dateRange={dateRange}
          aiSummaryContent={aiSummaryContent}
        />
      </div>
    </div>
  );
}
