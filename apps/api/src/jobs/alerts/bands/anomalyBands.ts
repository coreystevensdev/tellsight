// anomaly_fires skips the threshold-multiple formula entirely: its threshold
// is already a confidence enum, not a number, so the band is just the
// current anomaly's own confidence ordinal once it meets the rule's minimum.
const CONFIDENCE_ORDINAL = { low: 1, moderate: 2, high: 3 } as const;

export function getBand(
  currentValue: number,
  threshold: 'low' | 'moderate' | 'high',
): number | null {
  const minOrdinal = CONFIDENCE_ORDINAL[threshold];
  return currentValue >= minOrdinal ? currentValue : null;
}

// AnomalyDetails carries a raw zScore, not a confidence bucket, so evaluateOrg
// needs a tier mapping before it can call getBand. 2.0 matches the existing
// significance bar scoring.ts already uses to decide an anomaly is worth
// surfacing (actionabilityScore); 2.5/3.0 step up from there.
export function confidenceOrdinalFromZScore(zScore: number): number {
  const abs = Math.abs(zScore);
  if (abs >= 3.0) return 3;
  if (abs >= 2.5) return 2;
  if (abs >= 2.0) return 1;
  return 0;
}

export { CONFIDENCE_ORDINAL };
