import Link from 'next/link';
import { AI_DISCLAIMER, stripAllStatTags } from 'shared/constants';

interface SharedInsightCardProps {
  orgName: string;
  dateRange: string;
  aiSummaryContent: string;
}

// Shared pages render prose only, no chart affordances are wired here
// (no chart data, no JS state). We strip <stat id="..."/> tokens so the
// raw markup never leaks into the shared view, even for cached summaries
// generated under prompt v1.4+.
function SummaryText({ text }: { text: string }) {
  const stripped = stripAllStatTags(text);
  const paragraphs = stripped.split('\n\n').filter(Boolean);

  return (
    <div className="max-w-prose text-base leading-[1.6] md:text-[17px] md:leading-[1.8] [&>p+p]:mt-[1.5em]">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

export default function SharedInsightCard({
  orgName,
  dateRange,
  aiSummaryContent,
}: SharedInsightCardProps) {
  return (
    <article className="w-full max-w-2xl motion-reduce:duration-0">
      <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-6 shadow-md md:p-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-card-foreground md:text-2xl">
            {orgName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{dateRange}</p>
        </header>

        <SummaryText text={aiSummaryContent} />
        <p className="mt-6 text-[11px] leading-tight text-muted-foreground/60">{AI_DISCLAIMER}</p>
      </div>

      <div className="mt-6 flex justify-center">
        <Link
          href="/login"
          className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-primary px-6 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:w-auto md:min-w-[320px]"
        >
          Get insights like these for your business, Free to start
        </Link>
      </div>
    </article>
  );
}
