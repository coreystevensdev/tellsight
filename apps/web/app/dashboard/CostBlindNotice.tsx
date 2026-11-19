import Link from 'next/link';
import { EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';

interface CostBlindNoticeProps {
  /** Source types from the API, empty when the dataset can see costs. */
  sources: string[] | undefined;
  className?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  shopify: 'Shopify',
  square: 'Square',
};

function label(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** "Shopify" / "Shopify and Square" / "Shopify, Square and X". */
export function joinSources(sources: string[]): string {
  const names = sources.map(label);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Says which insights this dataset cannot produce, and why.
 *
 * DW-279: a revenue-only connector produces a confident dashboard made of
 * totals and averages, with margin and break-even simply absent and nothing
 * saying they were never computable. The pipeline is not failing, so there is no
 * error state; the owner just sees fewer things and has no way to know it.
 *
 * Deliberately **not dismissible**, unlike `DigestPausingBanner`. That one warns
 * about something that will happen and then resolves. This is a standing
 * property of the connector, so a dismiss would restore exactly the silence the
 * notice exists to end, and permanently, from one click.
 *
 * Deliberately not an error colour either. Nothing is broken and the owner did
 * nothing wrong, so it borrows `LockedInsightCard`'s dashed-border treatment:
 * the visual language the product already uses for "this is available, under a
 * condition you have not met".
 */
export function CostBlindNotice({ sources, className }: CostBlindNoticeProps) {
  if (!sources || sources.length === 0) return null;

  const named = joinSources(sources);
  const plural = sources.length > 1;

  return (
    <div
      role="note"
      className={cn(
        'rounded-xl border border-dashed border-border bg-card p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground" aria-hidden="true">
          <EyeOff className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">
            Profit margin and break-even need your costs
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {named} {plural ? 'report' : 'reports'} money coming in, not what you spend, so there is
            nothing to measure revenue against. Everything else on this page is computed from the
            sales {named} {plural ? 'send' : 'sends'}.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Connecting accounting software or a bank account fills in the other side. So does a CSV
            with expense rows in it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/settings/integrations"
              className="inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Connect a source
            </Link>
            <Link
              href="/upload"
              className="inline-block rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Upload a CSV
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
