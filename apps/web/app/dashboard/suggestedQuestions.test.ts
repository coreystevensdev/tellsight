import { describe, it, expect } from 'vitest';
import { getSuggestedQuestions, questionForChartPoint } from './suggestedQuestions';

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

// The canned questions above are deliberately generic because the metadata path
// carries only stat-type strings. A chart click is the exception: the datum it
// came from still has the month or the category, so the question can name the
// thing the user actually pointed at.
describe('questionForChartPoint', () => {
  it('names the month for a revenue point', () => {
    expect(questionForChartPoint({ chart: 'revenue', month: 'March 2026' }))
      .toBe('What happened to revenue in March 2026?');
  });

  it('names the category for an expense bar', () => {
    expect(questionForChartPoint({ chart: 'expense', category: 'Payroll' }))
      .toBe("What's driving my Payroll spending?");
  });

  // Categories come from uploaded CSV headers, so they arrive as whatever the
  // spreadsheet had. The question is interpolated, never parsed, so this is
  // about the text reading sensibly rather than about escaping.
  it('passes a category with punctuation through unchanged', () => {
    expect(questionForChartPoint({ chart: 'expense', category: 'Rent & Utilities' }))
      .toContain('Rent & Utilities');
  });
});
