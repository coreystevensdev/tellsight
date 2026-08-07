import { describe, it, expect } from 'vitest';
import { getSuggestedQuestions } from './suggestedQuestions';

describe('getSuggestedQuestions', () => {
  it('returns generic fallback questions when statTypes is undefined', () => {
    const result = getSuggestedQuestions(undefined);
    expect(result).toHaveLength(3);
    expect(result).toContain('How did revenue trend this quarter?');
  });

  it('returns generic fallback questions when statTypes is empty', () => {
    expect(getSuggestedQuestions([])).toHaveLength(3);
  });

  it('maps known stat types to their specific question', () => {
    const result = getSuggestedQuestions(['anomaly']);
    expect(result).toContain("What's driving the biggest anomaly in my data?");
  });

  it('deduplicates when the same stat type appears more than once', () => {
    const result = getSuggestedQuestions(['anomaly', 'anomaly']);
    const anomalyMatches = result.filter((q) => q.includes('anomaly'));
    expect(anomalyMatches).toHaveLength(1);
  });

  it('backfills with fallback questions when fewer than 3 stat types match', () => {
    const result = getSuggestedQuestions(['anomaly']);
    expect(result).toHaveLength(3);
  });

  it('ignores unknown stat types and still backfills to 3', () => {
    const result = getSuggestedQuestions(['some_future_stat_type']);
    expect(result).toHaveLength(3);
  });

  it('caps at 3 even when more than 3 stat types match', () => {
    const result = getSuggestedQuestions(['anomaly', 'trend', 'margin_trend', 'year_over_year']);
    expect(result).toHaveLength(3);
  });
});
