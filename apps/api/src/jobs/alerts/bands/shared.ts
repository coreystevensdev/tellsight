// Shared by the three "higher is worse" kinds (margin, cash burn, break-even),
// see Design Notes in the story spec for why runway and anomaly don't fit
// this shape and get their own formulas.
export function higherIsWorseBand(currentValue: number, threshold: number): number | null {
  if (currentValue >= threshold * 2) return 3;
  if (currentValue >= threshold * 1.5) return 2;
  if (currentValue >= threshold) return 1;
  return null;
}
