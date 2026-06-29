// Prompt builders for the two LLM judges. Each returns the provider's PromptInput
// ({ system, user }). The system half pins the judge to a single job and a strict
// JSON contract; the user half carries the case-specific inputs.
//
// On temperature: AC asks for temperature 0. The judge runs through the shared
// getProvider().generate(), which exposes no temperature knob (and the story bars
// touching the provider or using the SDK directly). So determinism is requested in
// the prompt, not enforced at the API. The tasks here are extraction/labelling,
// which are low-variance even at the provider default; the harness also averages
// across samples. See the story's Dev Agent Record for this limitation.

import type { PromptInput } from '../../apps/api/src/services/aiInterpretation/provider.js';
import type { StatType } from '../../apps/api/src/services/curation/types.js';

// What each stat type means, so the completeness judge can tell "addressed" from
// "name-dropped". Keyed by the StatType string literals.
const STAT_TYPE_GLOSS: Record<string, string> = {
  total: 'Total: a summed amount for a category',
  average: 'Average: the mean (and median) of a category',
  trend: 'Trend: direction and percent change of a series over time',
  anomaly: 'Anomaly: a value far outside the normal range (z-score / IQR)',
  category_breakdown: 'Category Breakdown: one category as a share of the whole',
  year_over_year: 'Year-over-Year: this period versus the same period last year',
  margin_trend: 'Margin Trend: profit margin direction, recent vs prior',
  seasonal_projection: 'Seasonal Projection: a forecast for a month from prior-year seasonality',
  cash_flow: 'Cash Flow: net burning or surplus per month over a trailing window',
  runway: 'Runway: months of cash left at the current burn rate',
  break_even: 'Break-Even: revenue needed to cover fixed costs, and the gap to it',
  cash_forecast: 'Cash Forecast: projected balance over the next months and any zero crossing',
};

const FAITHFULNESS_SYSTEM = `You are a strict fact-checker grading a financial summary for faithfulness.

You receive two things: GROUND TRUTH (the exact list of statistics the writer was given) and SUMMARY (what they wrote). Your only job is to check whether the summary's factual and numeric claims trace back to the ground truth.

Extract every distinct factual or numeric claim in the summary. For each, assign one label:
- "supported": the claim restates a figure, direction, or fact present verbatim or near-verbatim in the ground truth.
- "derived": the claim is not stated outright but follows by simple arithmetic or direct comparison of ground-truth figures (e.g. "payroll is about 40% of revenue" from a payroll total and a revenue total). Legitimate reasoning, not invention.
- "unsupported": the claim asserts a figure or fact that is neither present in nor derivable from the ground truth.

Hedging language, advice framing, and generic encouragement are not claims; skip them. Judge only checkable assertions.

Be deterministic: same inputs, same output. Respond with JSON only, no prose, no code fences. Shape:
{"claims":[{"claim":"<short quote or paraphrase>","label":"supported|derived|unsupported","reason":"<one clause>"}]}`;

const COMPLETENESS_SYSTEM = `You are grading a financial summary for completeness against an answer key.

You receive an ANSWER KEY (the stat types a complete summary must cover) and the SUMMARY. For each answer-key item, decide whether the summary meaningfully addresses it.

"Meaningfully addresses" means the summary conveys that stat's figure or its direction. Merely naming the topic without a number or a direction does NOT count (e.g. "cash flow is worth watching" does not address a Cash Flow stat; "you're spending about $10k more than you earn each month" does).

Return exactly one entry per answer-key item, in the same order, echoing its statType. Be deterministic. Respond with JSON only, no prose, no code fences. Shape:
{"items":[{"statType":"<echoed>","addressed":true|false,"evidence":"<quote or 'none'>"}]}`;

export function faithfulnessJudge(statSummaries: string, summary: string): PromptInput {
  return {
    system: FAITHFULNESS_SYSTEM,
    user: `GROUND TRUTH (the only figures the writer was given):\n${statSummaries}\n\nSUMMARY:\n${summary}`,
  };
}

export function completenessJudge(answerKey: StatType[], summary: string): PromptInput {
  const key = answerKey.map((t) => `- ${t}: ${STAT_TYPE_GLOSS[t] ?? t}`).join('\n');
  return {
    system: COMPLETENESS_SYSTEM,
    user: `ANSWER KEY (${answerKey.length} items the summary must cover):\n${key}\n\nSUMMARY:\n${summary}`,
  };
}
