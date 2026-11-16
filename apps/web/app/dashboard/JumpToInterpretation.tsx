'use client';

import { ArrowDown } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface JumpToInterpretationProps {
  targetId: string;
  className?: string;
}

/**
 * Skips the charts to reach the summary. The PRD pre-registered this when the
 * interpretation moved below the charts it describes, and named it rather than
 * a re-reversal:
 *
 *   on a phone the interpretation now sits below six charts, so a returning
 *   owner scrolls to reach the thing the product is for. If that turns out to
 *   hurt, the fix is an affordance that jumps to it, not a re-reversal.
 *
 * Mobile only, by the caller's `md:hidden`. On desktop the summary is close
 * enough that a button to reach it is noise.
 */
export function JumpToInterpretation({ targetId, className }: JumpToInterpretationProps) {
  const jump = () => {
    // No render-time existence check: the caller renders this and the target as
    // siblings under the same `hasData` branch, so an absent target is not a
    // reachable state. If the layout ever separates them, this makes the click
    // a no-op rather than a crash.
    const target = document.getElementById(targetId);
    if (!target) return;
    // globals.css already neuters CSS transitions under prefers-reduced-motion,
    // but this is a JS scroll and the media query cannot reach it.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <Button variant="ghost" size="sm" onClick={jump} className={className}>
      Skip to interpretation
      <ArrowDown aria-hidden="true" className="ml-1.5 size-4" />
    </Button>
  );
}
