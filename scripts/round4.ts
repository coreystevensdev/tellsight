// Shared by validate-seed.ts and proposal-precision-check.ts, both need the
// same 4-decimal rounding for their snapshot comparisons to agree byte-for-byte.
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
