import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { JumpToInterpretation } from './JumpToInterpretation';

// The PRD pre-registered this fix when the summary moved below the charts:
// "on a phone the interpretation now sits below six charts, so a returning
// owner scrolls to reach the thing the product is for. If that turns out to
// hurt, the fix is an affordance that jumps to it, not a re-reversal."
describe('JumpToInterpretation', () => {
  let scrollIntoView: (opts?: boolean | ScrollIntoViewOptions) => void;

  beforeEach(() => {
    scrollIntoView = vi.fn<(opts?: boolean | ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrollIntoView;
    const target = document.createElement('div');
    target.id = 'dashboard-interpretation';
    document.body.append(target);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const setReducedMotion = (reduce: boolean) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
  };

  it('scrolls the interpretation into view when pressed', async () => {
    setReducedMotion(false);
    render(<JumpToInterpretation targetId="dashboard-interpretation" />);

    await userEvent.click(screen.getByRole('button'));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  // globals.css neuters CSS transitions under prefers-reduced-motion, but
  // scrollIntoView is JS and the media query cannot reach it. Without this the
  // affordance would animate for someone who asked it not to.
  it('jumps without animating when the user asked for reduced motion', async () => {
    setReducedMotion(true);
    render(<JumpToInterpretation targetId="dashboard-interpretation" />);

    await userEvent.click(screen.getByRole('button'));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  // The caller renders this and the target as siblings under one `hasData`
  // branch, so an absent target is unreachable today. The `if (!target) return`
  // it documents is also required by the type system, since getElementById
  // returns HTMLElement | null.
  //
  // Honest limit: this does not pin that guard. Deleting it leaves this test
  // green, because scrollIntoView goes uncalled whether the handler returns
  // early or throws on the null, and neither userEvent nor a console.error spy
  // surfaced the difference here. It documents the intent, not the mechanism.
  it('does not scroll when the target is absent', async () => {
    setReducedMotion(false);
    document.body.replaceChildren();

    render(<JumpToInterpretation targetId="dashboard-interpretation" />);

    await userEvent.click(screen.getByRole('button'));

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('names what it jumps to, for a screen reader reading it out of context', () => {
    setReducedMotion(false);
    render(<JumpToInterpretation targetId="dashboard-interpretation" />);

    expect(screen.getByRole('button')).toHaveAccessibleName(/interpretation/i);
  });
});
