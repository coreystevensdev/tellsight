// FR22 was a per-sample floor, on the reading that "at least one non-obvious,
// actionable insight per analysis" is violated by any single analysis without one.
// Literally true, and unusable as a gate: the measured miss rate on v1.9 is 1 in
// 35, so a zero-miss floor fails a healthy run roughly a quarter of the time at
// the default sample size, and a gate that cries wolf gets ignored.
//
// Pooled across the whole run instead. The ceiling sits above one miss at the
// default 3 fixtures x 3 samples (11.1%), because anything below that is the old
// gate with extra steps. It still catches a regression the size of v1.7's, 5
// misses in 18.
//
// Read the printed rate, not just pass or fail. At 9 samples this cannot tell 3%
// from 12%; it guards against gross regressions and nothing finer. Raising SAMPLES
// is what makes it sharp.
export const INSIGHT_MISS_CEILING = 0.15;

interface Scored {
  insight: { misses: number };
  sampledCount: number;
}

export function insightGate(fixtures: Scored[]) {
  const misses = fixtures.reduce((n, f) => n + f.insight.misses, 0);
  const samples = fixtures.reduce((n, f) => n + f.sampledCount, 0);
  const rate = samples === 0 ? 0 : misses / samples;
  return { misses, samples, rate, over: rate > INSIGHT_MISS_CEILING };
}
