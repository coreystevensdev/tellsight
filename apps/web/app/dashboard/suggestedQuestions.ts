const QUESTIONS_BY_STAT_TYPE: Record<string, string> = {
  anomaly: "What's driving the biggest anomaly in my data?",
  trend: "What's my strongest growth trend right now?",
  margin_trend: 'Is my profit margin expanding or shrinking?',
  year_over_year: 'How does this year compare to last year?',
};

const FALLBACK_QUESTIONS = [
  'How did revenue trend this quarter?',
  "What's my biggest expense category?",
  'Am I profitable this month?',
];

const MAX_SUGGESTIONS = 3;

// TransparencyMetadata.statTypes only carries type strings (no category,
// direction, or month), so these stay generic rather than data-specific.
// A fully concrete "why did Payroll increase in March" question needs the
// structured ScoredInsight data, which never reaches the browser today.
export function getSuggestedQuestions(statTypes: string[] | undefined): string[] {
  if (!statTypes?.length) return FALLBACK_QUESTIONS.slice(0, MAX_SUGGESTIONS);

  const matched = statTypes
    .map((type) => QUESTIONS_BY_STAT_TYPE[type])
    .filter((q): q is string => q !== undefined);

  const deduped = [...new Set(matched)];
  if (deduped.length >= MAX_SUGGESTIONS) return deduped.slice(0, MAX_SUGGESTIONS);

  for (const fallback of FALLBACK_QUESTIONS) {
    if (deduped.length >= MAX_SUGGESTIONS) break;
    if (!deduped.includes(fallback)) deduped.push(fallback);
  }
  return deduped;
}
