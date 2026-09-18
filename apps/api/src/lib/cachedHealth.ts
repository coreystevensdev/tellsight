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
export function cachedHealth<T>(ttlMs: number, probe: () => Promise<T>): () => Promise<T> {
  let cachedAt = 0;
  let cached: T | null = null;
  let inflight: Promise<T> | null = null;

  return async () => {
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
}
