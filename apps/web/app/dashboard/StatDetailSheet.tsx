'use client';

import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useStatDetail } from '@/lib/hooks/useStatDetail';

export interface StatDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: number | null;
  statId: string | null;
}

function statTypeLabel(statType: string): string {
  return statType.replace(/_/g, ' ');
}

function LoadingSpinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin motion-reduce:animate-none"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// Per-claim reconciliation view: fetches the value + arithmetic (or method)
// behind one <cite> tag. Separate from InsightChartSheet (chart drill-down,
// gated on getStatChartConfig covering 6 of 12 stat types) and
// TransparencyPanel (whole-summary methodology, single toggle). This one is
// addressable by stat instance and always has something to show for all 12.
export function StatDetailSheet({ open, onOpenChange, datasetId, statId }: StatDetailSheetProps) {
  const isMobile = useIsMobile();
  const { status, data, error } = useStatDetail(open ? datasetId : null, open ? statId : null);

  if (!statId) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={isMobile ? 'h-[85vh] rounded-t-xl' : 'sm:max-w-lg'}
      >
        <SheetTitle>{data ? statTypeLabel(data.statType) : 'Citation detail'}</SheetTitle>
        <SheetDescription className="sr-only">
          Shows the exact value and arithmetic or method behind this cited figure.
        </SheetDescription>

        <div
          className="mt-4 flex flex-col gap-4 overflow-y-auto px-4 pb-6"
          aria-live="polite"
          aria-busy={status === 'loading'}
        >
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoadingSpinner />
              Loading...
            </div>
          )}

          {status === 'error' && error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {status === 'done' && data && (
            <>
              <p className="text-base font-medium text-card-foreground">
                {data.detail.kind === 'formula' ? data.detail.expression : data.detail.methodName}
              </p>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                {(data.detail.kind === 'formula' ? data.detail.terms : data.detail.inputs).map((term) => (
                  <div key={term.label} className="contents">
                    <dt className="text-muted-foreground">{term.label}</dt>
                    <dd className="text-right font-medium tabular-nums text-card-foreground">{term.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
