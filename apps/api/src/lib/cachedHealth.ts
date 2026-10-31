/**
 * Memoizes a health probe for a short window.
 *
 * The container healthcheck curls /health every 30 seconds and that handler ran
 * every probe live, so the Stripe check alone was two API calls a minute, day
 * and night, to answer a question whose answer changes about once a quarter.
 *
 * The window does not cost freshness where it matters. The cache is per-process,
 * so a deploy restarting the container clears it, and the post-deploy poll and
 * the boot log both read a fresh result. What it drops is the steady-state
 * repetition in between.
 *
 * Single-flight as well as cached: /health and /health/ready can be in the air
 * at once, and two concurrent misses should make one call, not two.
 */
/**
 * The returned function probes on a cold cache. `peek` never does: it hands
 * back whatever the last probe found, or null if none has run.
 *
 * That distinction exists because not every caller should be able to spend.
 * The Claude probe buys a one-token completion to prove the account can
 * actually pay, and /health/ready is hit by the Route53 health check every
 * thirty seconds, so calling it there turned an infrastructure poll into a
 * standing order for third-party requests. Reporting a cached answer costs
 * nothing and is just as true: the number came from a real call a few minutes
 * ago either way.
 */
/** What `peek` hands back: the last result and when it was taken. */
export interface PeekedHealth<T> {
  value: T;
  cachedAt: number;
}

export type CachedHealth<T> = (() => Promise<T>) & { peek: () => PeekedHealth<T> | null };

export function cachedHealth<T>(ttlMs: number, probe: () => Promise<T>): CachedHealth<T> {
  let cachedAt = 0;
  let cached: T | null = null;
  let inflight: Promise<T> | null = null;

  const get = async () => {
    if (cached !== null && Date.now() - cachedAt < ttlMs) return cached;
    if (inflight) return inflight;

    inflight = probe()
      .then((result) => {
        cached = result;
        cachedAt = Date.now();
        return result;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  };

  // Deliberately ignores the TTL. A stale read is the point: the alternative
  // for a frequently polled endpoint is either a fresh paid call or no answer
  // at all, and a few minutes old is the better of the three.
  // Returns the timestamp alongside the value, not just the value. A peeked
  // answer has no upper bound on its age: the readers that peek never refresh,
  // and the only other writer is the admin panel, which refreshes only while
  // somebody has it open. So a boot-time result can stand for the life of the
  // container, and a caller that cannot see how old it is has no way to tell a
  // two minute old answer from a six hour old one. Handing back cachedAt is
  // what lets the payload say so instead of implying freshness it does not
  // have.
  get.peek = () => (cached === null ? null : { value: cached, cachedAt });

  return get;
}
