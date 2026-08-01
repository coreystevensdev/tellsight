'use client';

import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useActionDrawer } from './ActionDrawerContext';

// Owners see Approve/Dismiss; everyone else sees the same list read-only.
// This is UX only -- roleGuard('owner') on PATCH /proposals/:id is the real
// authorization boundary, a member could still call the route directly and
// get rejected server-side.
export function ActionDrawer() {
  const isMobile = useIsMobile();
  const { open, setOpen, status, proposals, error, isOwner, resolveProposal } = useActionDrawer();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={isMobile ? 'h-[85vh] rounded-t-xl' : 'sm:max-w-lg'}
      >
        <SheetTitle>Pending proposals</SheetTitle>
        <SheetDescription className="sr-only">
          Findings the agent flagged for review, with a recommendation you can approve or dismiss.
        </SheetDescription>

        <div
          className="mt-4 flex flex-col gap-3 overflow-y-auto px-4 pb-6"
          aria-live="polite"
          aria-busy={status === 'loading'}
        >
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Loading...
            </div>
          )}

          {status === 'error' && (
            <p className="text-sm text-destructive">Couldn&apos;t load pending proposals.</p>
          )}

          {status === 'done' && error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}

          {status === 'done' && proposals.length === 0 && (
            <p className="text-sm text-muted-foreground">No pending proposals right now.</p>
          )}

          {proposals.map((p) => (
            <div key={p.id} className="rounded-lg border border-border p-4">
              <p className="text-sm font-medium text-card-foreground">{p.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{p.explanation}</p>
              <p className="mt-2 text-sm text-card-foreground">{p.recommendation}</p>

              {isOwner && (
                <div className="mt-3 flex gap-2">
                  <Button type="button" size="sm" onClick={() => resolveProposal(p.id, 'approved')}>
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => resolveProposal(p.id, 'rejected')}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
