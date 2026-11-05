export interface TransparencyMetadata {
  statTypes: string[];
  categoryCount: number;
  insightCount: number;
  scoringWeights: {
    novelty: number;
    actionability: number;
    specificity: number;
  };
  promptVersion: string;
  generatedAt: string;
  // Optional: a row cached before this field existed genuinely lacks it, and
  // the dashboard hands cached metadata straight through without re-parsing it.
  suppressedForSampleSize?: number;
}
