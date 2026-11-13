// A shed sample never reached the API, so it is an absent measurement rather
// than a bad one, which is the distinction DW-250 turns on. Waiting out the
// breaker's cooldown and running it again completes the measurement rather than
// cherry-picking it: a sample that never ran is simply run.
//
// Without this, three consecutive upstream failures end an arm. anthropicBreakers.ts
// trips at 3 and half-opens after 30s, and the sample loops run back to back, so
// the cooldown never elapses and every later sample sheds. eval-summaries.ts has
// said so in a comment since DW-242 without anything acting on it. One transient
// cluster voided a 36-sample run three times on 2026-11-12, the last of them
// losing 49 samples and leaving the scorecard's whole agent section null.
//
// Deliberately not a blanket inter-sample delay: a healthy run should not pay
// 36 waits to survive a bad patch that usually is not there.
export const SHED_RETRY_WAIT_MS = 35_000; // the breaker's 30s cooldown, plus margin
export const SHED_RETRIES_PER_SAMPLE = 3;

export interface ShedState {
  /** The sample index the current retry budget belongs to. */
  index: number;
  used: number;
}

export const freshShedState = (): ShedState => ({ index: -1, used: 0 });

/**
 * Decides what a shed sample should do next, and advances the budget.
 *
 * Returns `retry` while the sample has budget left, `giveUp` once it is spent.
 * The budget is per sample: moving to a new index resets it, so an arm that
 * sheds once on each of several samples is not punished for an earlier one.
 */
export function onShed(
  state: ShedState,
  index: number,
  max: number = SHED_RETRIES_PER_SAMPLE,
): { action: 'retry' | 'giveUp'; attempt: number } {
  if (state.index !== index) {
    state.index = index;
    state.used = 0;
  }
  if (state.used >= max) return { action: 'giveUp', attempt: state.used };
  state.used += 1;
  return { action: 'retry', attempt: state.used };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
