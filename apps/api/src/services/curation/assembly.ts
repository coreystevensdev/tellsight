import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '../../lib/appError.js';
import type { ScoredInsight, AssembledContext, TransparencyMetadata } from './types.js';
import { StatType } from './types.js';
import type { BusinessProfile } from 'shared/types';
import { getIndustryBenchmarks } from './config/industry-benchmarks.js';
import { statInstanceId } from './computation.js';
import { isBelowFloor } from './sampleSizeFloors.js';
import { scoringConfig } from './scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VERSION = 'v2.3';
export const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Signed currency with explicit `+` for positives, used for CashFlow and
// Runway net figures where the reader expects to see direction at a glance.
export const usdSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${usd.format(Math.abs(n))}`;

// Signed currency that omits the `+` for positives, used for break-even gap
// and forecast balances where a bare `$X` reads naturally and `-$X` flags
// the negative case. Matches the editorial posture of the owner framing.
export const usdMinus = (n: number) => (n >= 0 ? `$${usd.format(n)}` : `-$${usd.format(Math.abs(n))}`);

// Minus outside the symbol, with the digit grouping each site already used.
// DW-246 only needed the sign handled: these sites could not render a negative
// before a contra entry existed. Routing them through usdMinus would also have
// added thousands separators, turning every trend line's `$1000 -> $2000` into
// `$1,000 -> $2,000` for every org, which is a prompt change nobody measured.
const signedCents = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const signedWhole = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(0)}`;

interface SplitTemplate {
  system: string;
  user: string;
}

// v1.6+ ships split templates so the system half can be prompt-cached.
// v1-v1.5 and v1-digest stay single-file; for those, the whole content goes
// in `user` and `system` is empty. The LlmProvider sends an empty system as
// "no caching".
function loadTemplate(version: string): SplitTemplate {
  const dir = resolve(__dirname, 'config', 'prompt-templates');
  const splitSystem = resolve(dir, `${version}-system.md`);
  const splitUser = resolve(dir, `${version}-user.md`);

  try {
    return {
      system: readFileSync(splitSystem, 'utf-8'),
      user: readFileSync(splitUser, 'utf-8'),
    };
  } catch {
    // Split files absent, fall back to single-file convention.
  }

  const singlePath = resolve(dir, `${version}.md`);
  try {
    return { system: '', user: readFileSync(singlePath, 'utf-8') };
  } catch (err) {
    throw new AppError(
      `Prompt template missing: tried ${version}-system.md/${version}-user.md and ${version}.md`,
      'CONFIG_ERROR',
      500,
      err,
    );
  }
}

const templateCache = new Map<string, SplitTemplate>();

function getTemplate(version: string): SplitTemplate {
  let tpl = templateCache.get(version);
  if (!tpl) {
    tpl = loadTemplate(version);
    templateCache.set(version, tpl);
  }
  return tpl;
}

// Prompt versions that render cash flow's monthly series. Still gated rather
// than unconditional, because the eval pins older versions to reproduce past
// measurements and an older arm has to produce the prompt it originally
// produced.
//
// v2.2 rendered revenue alone and is deleted, not kept as an option. Measured at
// 36 samples a side it was indistinguishable from no series at all (t=0.11) and
// raised total deductions from 32 to 40, because the model could see revenue
// climbing month by month, knew expenses grew 12% in aggregate, and inferred a
// monthly surplus trend it had never been given. Showing half a series is
// itself a prompt. Leaving it pinnable would invite someone reproducing the
// worse arm by accident; the finding lives in the ledger and in 6c3e818.
const MONTHLY_CASH_FLOW_VERSIONS = new Set(['v2.3']);

function formatStatBody(insight: ScoredInsight, promptVersion: string): string {
  const { stat, score } = insight;
  const category = stat.category ?? 'Overall';

  switch (stat.statType) {
    case StatType.Total:
      return `- [${category}] Total: ${usdMinus(stat.value)} (${stat.details.count} transactions, relevance: ${score.toFixed(2)})`;
    case StatType.Average:
      return `- [${category}] Average: ${signedCents(stat.value)}, median: ${signedCents(stat.details.median)} (relevance: ${score.toFixed(2)})`;
    case StatType.Trend: {
      const dir = stat.details.growthPercent >= 0 ? 'up' : 'down';
      return `- [${category}] Trend (${stat.details.firstPeriod} to ${stat.details.lastPeriod}): ${dir} ${Math.abs(stat.details.growthPercent).toFixed(1)}% over ${stat.details.dataPoints} months (${signedWhole(stat.details.firstValue)} -> ${signedWhole(stat.details.lastValue)}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.Anomaly: {
      const dir = stat.details.direction;
      return `- [${category}] Anomaly (${stat.details.period}): ${signedCents(stat.value)} is ${dir} normal (z-score: ${stat.details.zScore.toFixed(2)}, expected range: ${signedWhole(stat.details.iqrBounds.lower)} to ${signedWhole(stat.details.iqrBounds.upper)}, relevance: ${score.toFixed(2)})`;
    }
    // DW-246: usdMinus and "to" rather than `$X-$Y`. A contra entry can put a
    // negative at either end now, and `$-3000-$500` cannot be read reliably by
    // a model or a person.
    case StatType.CategoryBreakdown:
      return `- [${category}] Breakdown: ${stat.details.percentage.toFixed(1)}% of total ($${usd.format(stat.details.absoluteTotal)}, ${stat.details.transactionCount} transactions, range: ${signedWhole(stat.details.min)} to ${signedWhole(stat.details.max)}, relevance: ${score.toFixed(2)})`;
    case StatType.YearOverYear:
      return `- [${category}] Year-over-Year (${stat.details.month}): $${usd.format(stat.details.currentRevenue)} in ${stat.details.currentYearLabel} vs $${usd.format(stat.details.priorRevenue)} in ${stat.details.priorYearLabel} (${stat.details.changePercent >= 0 ? '+' : ''}${stat.details.changePercent.toFixed(1)}%, relevance: ${score.toFixed(2)})`;
    case StatType.MarginTrend: {
      const dir = stat.details.direction;
      return `- [Overall] Margin Trend: ${dir}, recent ${stat.details.recentMarginPercent.toFixed(1)}% vs prior ${stat.details.priorMarginPercent.toFixed(1)}% (revenue ${stat.details.revenueGrowthPercent >= 0 ? '+' : ''}${stat.details.revenueGrowthPercent.toFixed(1)}%, expenses ${stat.details.expenseGrowthPercent >= 0 ? '+' : ''}${stat.details.expenseGrowthPercent.toFixed(1)}%, relevance: ${score.toFixed(2)})`;
    }
    case StatType.SeasonalProjection:
      return `- [${category}] Seasonal Projection: ${stat.details.projectedMonth} estimated at $${usd.format(stat.details.projectedAmount)} based on ${stat.details.basisMonths.join(', ')} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    case StatType.CashFlow: {
      const head = `- [Overall] Cash Flow: ${stat.details.direction}, net ${usdSigned(stat.details.monthlyNet)}/mo over ${stat.details.trailingMonths} months (${stat.details.monthsBurning} burning, relevance: ${score.toFixed(2)})`;
      // recentMonths is populated on every stat the producer emits
      // (cashFlowMetrics.ts:52-56) and was discarded here, so the model got a
      // trend's endpoints and no way to tell a steady climb from one good
      // month. validator.ts:109-113 has accepted these figures as citable
      // since its first commit, so nothing there needs widening.
      //
      // All three figures per month, not revenue alone. Revenue alone shipped as
      // v2.2 and measured worse than no series at all, because the model could
      // see revenue climbing and inferred the surplus trend it had not been
      // given. See the note on MONTHLY_CASH_FLOW_VERSIONS above.
      if (!MONTHLY_CASH_FLOW_VERSIONS.has(promptVersion) || stat.details.recentMonths.length === 0) {
        return head;
      }
      // usd for the gross figures and usdSigned for net, matching the stated
      // convention above: direction at a glance where the reader expects it.
      const months = stat.details.recentMonths
        .map(
          (m) =>
            `${m.month} rev $${usd.format(m.revenue)} exp $${usd.format(m.expenses)} net ${usdSigned(m.net)}`,
        )
        .join(', ');
      // One line, because formatStat appends the [cite: id] marker to whatever
      // this returns and v2.1-system.md rule 12 tells the model that each stat
      // line *ends with* that marker. A two-line body put the marker on the
      // monthly figures and left the cash-flow line without one, which both
      // breaks the stated contract and points the citation at the wrong claim.
      return `${head}; by month ${months}`;
    }
    case StatType.Runway: {
      const cash = `$${usd.format(stat.details.cashOnHand)}`;
      const asOf = stat.details.cashAsOfDate.slice(0, 10); // YYYY-MM-DD
      return `- [Overall] Runway: ${stat.details.runwayMonths.toFixed(1)} months, net ${usdSigned(stat.details.monthlyNet)}/mo, cash ${cash} as of ${asOf} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.BreakEven: {
      const be = `$${usd.format(stat.details.breakEvenRevenue)}`;
      const cur = `$${usd.format(stat.details.currentMonthlyRevenue)}`;
      return `- [Overall] Break-Even: ${be}/mo at ${stat.details.marginPercent.toFixed(1)}% margin, current revenue ${cur}/mo, gap ${usdMinus(stat.details.gap)} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.CategoryVariance: {
      const word = stat.details.direction === 'over' ? 'over' : stat.details.direction === 'under' ? 'under' : 'on';
      return `- [${category}] Plan vs actual (${stat.details.monthLabel}): planned $${usd.format(stat.details.plannedMonthly)}, spent $${usd.format(stat.details.actualMonthly)}, ${word} plan by ${Math.abs(stat.details.variancePercent).toFixed(1)}% (relevance: ${score.toFixed(2)})`;
    }

    case StatType.CashForecast: {
      const chain = [stat.details.startingBalance, ...stat.details.projectedMonths.map((p) => p.projectedBalance)]
        .map(usdMinus)
        .join(' → ');
      const crossing = stat.details.crossesZeroAtMonth !== null
        ? `, balance crosses zero around month ${stat.details.crossesZeroAtMonth}`
        : '';
      return `- [Overall] Cash Forecast: balance ${chain} over next 3 months${crossing} (method: ${stat.details.method}, confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
  }
}

// Appends the exact id the LLM must copy into a <cite id="..."/> token, see
// v1.6-system.md rule 12. Every stat line carries one, regardless of which
// prompt template renders it (digest and alert templates get the suffix too,
// see validator.ts Tier 2b for the defense-in-depth this implies).
function formatStat(insight: ScoredInsight, datasetId: number, promptVersion: string): string {
  return `${formatStatBody(insight, promptVersion)} [cite: ${statInstanceId(insight.stat, datasetId)}]`;
}

const TEAM_SIZE_LABELS: Record<string, string> = {
  solo: '1 person (solo)',
  '2_5': '2-5 employees',
  '6_20': '6-20 employees',
  over_20: '20+ employees',
};

const REVENUE_LABELS: Record<string, string> = {
  under_100k: 'under $100K/year',
  '100k_500k': '$100K-$500K/year',
  '500k_2m': '$500K-$2M/year',
  over_2m: 'over $2M/year',
};

const CONCERN_LABELS: Record<string, string> = {
  cash_flow: 'cash flow management',
  growth: 'revenue growth',
  cost_control: 'cost control',
  seasonal_planning: 'seasonal planning',
  profitability: 'profitability',
};

function formatBusinessContext(profile: BusinessProfile | null | undefined): string {
  if (!profile) return 'No business context available. Give general advice.';

  const type = profile.businessType.replace(/_/g, ' ');
  const revenue = REVENUE_LABELS[profile.revenueRange] ?? profile.revenueRange;
  const team = TEAM_SIZE_LABELS[profile.teamSize] ?? profile.teamSize;
  const concern = CONCERN_LABELS[profile.topConcern] ?? profile.topConcern;

  return `This is a ${type} business (${revenue}, ${team}). The owner's top concern is ${concern}. Tailor your advice to this context.`;
}

const KNOWN_PLACEHOLDERS = new Set([
  '{{statSummaries}}',
  '{{today}}',
  '{{businessContext}}',
  '{{industryBenchmarks}}',
  '{{statTypeList}}',
  '{{allowedStatTypes}}',
  '{{categoryCount}}',
  '{{insightCount}}',
  '{{priorContext}}',
]);

// Apply variable substitutions to the user-facing portion of the template.
// The system portion (v1.7+) has no placeholders and is returned unchanged.
function renderUser(
  template: string,
  vars: {
    statSummaries: string;
    today: string;
    businessContext: string;
    benchmarks: string;
    statTypeList: string;
    allowedStatTypes: string;
    categoryCount: string;
    insightCount: string;
    priorContext: string;
  },
): string {
  // Scan the raw template, never the substituted values, a CSV-sourced
  // stat.category containing literal `{{...}}` text must not trip this.
  const found = template.match(/\{\{[^{}]*\}\}/g) ?? [];
  const unknown = [...new Set(found.filter((token) => !KNOWN_PLACEHOLDERS.has(token)))];
  if (unknown.length > 0) {
    throw new AppError(`Prompt template contains unknown placeholder(s): ${unknown.join(', ')}`, 'CONFIG_ERROR', 500);
  }

  return template
    .replaceAll('{{statSummaries}}', vars.statSummaries)
    .replaceAll('{{today}}', vars.today)
    .replaceAll('{{businessContext}}', vars.businessContext)
    .replaceAll('{{industryBenchmarks}}', vars.benchmarks)
    .replaceAll('{{statTypeList}}', vars.statTypeList)
    .replaceAll('{{allowedStatTypes}}', vars.allowedStatTypes)
    .replaceAll('{{categoryCount}}', vars.categoryCount)
    .replaceAll('{{insightCount}}', vars.insightCount)
    .replaceAll('{{priorContext}}', vars.priorContext);
}

export function assemblePrompt(
  insights: ScoredInsight[],
  datasetId: number,
  promptVersion = DEFAULT_VERSION,
  businessProfile?: BusinessProfile | null,
  now: Date = new Date(),
  priorContext = '',
  isPreselected = false,
): AssembledContext {
  const template = getTemplate(promptVersion);
  const businessContext = formatBusinessContext(businessProfile);
  // UTC so the prompt agrees with metadata.generatedAt below, which is an ISO
  // string. Without it the two disagree about what day it is on any non-UTC
  // host. Per-org would be better than either, but orgs have no timezone field.
  const today = now.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const benchmarks = getIndustryBenchmarks(businessProfile?.businessType) ?? 'No industry benchmarks available.';

  // Gated here, not in scoreInsights: scoring ranks every candidate for every
  // consumer of ScoredInsight (digest, alerts, NL Q&A), and a thin stat can
  // legitimately outrank a thick one on novelty. This is the one place that
  // decides what the model actually gets told, so it is the one place a
  // below-floor stat gets cut rather than just outranked.
  //
  // Gated by default, not universally. The floor exists to stop this function
  // volunteering a weak statistic from a candidate pool, not to overrule a
  // deterministic rule that already examined this exact stat and found it
  // over a threshold (an alert firing). A model choosing which stat to write
  // about from a pool hasn't made that kind of decision: a prompt asking it
  // to be careful is a request, not a guarantee. isPreselected is how a
  // caller passing a single rule-selected stat says so; omitting it is
  // always safe, since false gates.
  //
  // Filtered before the topN cap, not after. `insights` here is the full
  // ranked candidate pool (runCurationPipeline's `scoredPool`), not the
  // already-capped array it also returns -- capping first would spend a
  // prompt slot on a below-floor stat and then cut it anyway, leaving the
  // prompt short even when enough above-floor stats exist to fill it.
  const aboveFloor = isPreselected ? insights : insights.filter((i) => !isBelowFloor(i.stat));
  const survivors = isPreselected ? aboveFloor : aboveFloor.slice(0, scoringConfig.topN);
  // Against aboveFloor, not survivors: survivors also drops anything that
  // simply lost the topN ranking, and that is not a sample-size suppression.
  const suppressedForSampleSize = insights.length - aboveFloor.length;

  if (survivors.length === 0) {
    const user = renderUser(template.user, {
      statSummaries:
        'No statistical insights available. The dataset may be empty or too small for meaningful analysis.',
      today,
      businessContext,
      benchmarks,
      statTypeList: 'none',
      allowedStatTypes: 'none',
      categoryCount: '0',
      insightCount: '0',
      priorContext,
    });

    return {
      system: template.system,
      user,
      metadata: {
        statTypes: [],
        categoryCount: 0,
        insightCount: 0,
        scoringWeights: { novelty: 0, actionability: 0, specificity: 0 },
        promptVersion,
        generatedAt: now.toISOString(),
        suppressedForSampleSize,
      },
      promptedStats: [],
    };
  }

  const statSummaries = survivors.map((i) => formatStat(i, datasetId, promptVersion)).join('\n');
  const statTypes = [...new Set(survivors.map((i) => i.stat.statType))];
  const allowedStatTypes = [...statTypes].sort().join(', ');
  const categories = new Set(survivors.map((i) => i.stat.category).filter(Boolean));
  const { breakdown } = survivors[0]!;

  const user = renderUser(template.user, {
    statSummaries,
    today,
    businessContext,
    benchmarks,
    statTypeList: statTypes.join(', '),
    allowedStatTypes,
    categoryCount: String(categories.size),
    insightCount: String(survivors.length),
    priorContext,
  });

  const metadata: TransparencyMetadata = {
    statTypes,
    categoryCount: categories.size,
    insightCount: survivors.length,
    scoringWeights: breakdown,
    promptVersion,
    generatedAt: now.toISOString(),
    suppressedForSampleSize,
  };

  return { system: template.system, user, metadata, promptedStats: survivors.map((i) => i.stat) };
}
