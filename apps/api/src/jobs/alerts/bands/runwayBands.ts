// Runway is a "lower is worse" metric: fewer months of cash left is more
// severe. Bands derive from the rule's own configured threshold rather than
// an invented business table, see the story spec's Design Notes.
export function getBand(currentValue: number, threshold: number): number | null {
  if (currentValue <= threshold / 4) return 3;
  if (currentValue <= threshold / 2) return 2;
  if (currentValue <= threshold) return 1;
  return null;
}
