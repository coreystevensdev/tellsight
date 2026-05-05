import { useId } from 'react';
import { ExternalLink } from 'lucide-react';

import { INVOICEFLOW_URL } from '@/lib/site-links';
import { cn } from '@/lib/utils';

export const INVOICEFLOW_CARD_HEADING = "Don't have a spreadsheet to upload?";

export const INVOICEFLOW_CARD_BODY =
  'InvoiceFlow extracts PDF invoices into a clean QBO-ready CSV: vendor, dates, line items, totals, with reasoning on every field. Same privacy posture: nothing stored, no account.';

interface InvoiceFlowCardProps {
  className?: string;
}

export function InvoiceFlowCard({ className }: InvoiceFlowCardProps) {
  const headingId = useId();

  return (
    <aside
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col rounded-lg border border-border bg-card p-6',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ExternalLink className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1">
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
            {INVOICEFLOW_CARD_HEADING}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{INVOICEFLOW_CARD_BODY}</p>
        </div>
      </div>

      <a
        href={INVOICEFLOW_URL}
        target="_blank"
        rel="noopener"
        className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto sm:self-start"
      >
        Open InvoiceFlow
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </aside>
  );
}
