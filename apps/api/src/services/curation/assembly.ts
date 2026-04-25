import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '../../lib/appError.js';
import type { ScoredInsight, AssembledContext, TransparencyMetadata } from './types.js';
import { StatType } from './types.js';
import type { BusinessProfile } from 'shared/types';
import { getIndustryBenchmarks } from './config/industry-benchmarks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VERSION = 'v1.6';
const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Signed currency with explicit `+` for positives — used for CashFlow and
// Runway net figures where the reader expects to see direction at a glance.
const usdSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${usd.format(Math.abs(n))}`;

// Signed currency that omits the `+` for positives — used for break-even gap
// and forecast balances where a bare `$X` reads naturally and `-$X` flags
// the negative case. Matches the editorial posture of the owner framing.
const usdMinus = (n: number) => (n >= 0 ? `$${usd.format(n)}` : `-$${usd.format(Math.abs(n))}`);

interface SplitTemplate {
  system: string;
  user: string;
}

// v1.7+ ships split templates so the system half can be prompt-cached.
// v1-v1.6 are single files; for those, the whole content goes in `user` and
// `system` is empty. The LlmProvider sends an empty system as "no caching".
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
    // Split files absent — fall back to single-file convention.
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

function formatStat(insight: ScoredInsight): string {
  const { stat, score } = insight;
  const category = stat.category ?? 'Overall';

  switch (stat.statType) {
    case StatType.Total:
      return `- [${category}] Total: $${usd.format(stat.value)} (${stat.details.count} transactions, relevance: ${score.toFixed(2)})`;
    case StatType.Average:
      return `- [${category}] Average: $${stat.value.toFixed(2)}, median: $${stat.details.median.toFixed(2)} (relevance: ${score.toFixed(2)})`;
    case StatType.Trend: {
      const dir = stat.details.growthPercent >= 0 ? 'up' : 'down';
      return `- [${category}] Trend: ${dir} ${Math.abs(stat.details.growthPercent).toFixed(1)}% over ${stat.details.dataPoints} periods ($${stat.details.firstValue.toFixed(0)} -> $${stat.details.lastValue.toFixed(0)}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.Anomaly: {
      const dir = stat.details.direction;
      return `- [${category}] Anomaly: $${stat.value.toFixed(2)} is ${dir} normal (z-score: ${stat.details.zScore.toFixed(2)}, expected range: $${stat.details.iqrBounds.lower.toFixed(0)}-$${stat.details.iqrBounds.upper.toFixed(0)}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.CategoryBreakdown:
      return `- [${category}] Breakdown: ${stat.details.percentage.toFixed(1)}% of total ($${usd.format(stat.details.absoluteTotal)}, ${stat.details.transactionCount} transactions, range: $${stat.details.min.toFixed(0)}-$${stat.details.max.toFixed(0)}, relevance: ${score.toFixed(2)})`;
    case StatType.YearOverYear:
      return `- [${category}] Year-over-Year (${stat.details.month}): $${usd.format(stat.details.currentYear)} in ${stat.details.currentYearLabel} vs $${usd.format(stat.details.priorYear)} in ${stat.details.priorYearLabel} (${stat.details.changePercent >= 0 ? '+' : ''}${stat.details.changePercent.toFixed(1)}%, relevance: ${score.toFixed(2)})`;
    case StatType.MarginTrend: {
      const dir = stat.details.direction;
      return `- [Overall] Margin Trend: ${dir} — recent ${stat.details.recentMarginPercent.toFixed(1)}% vs prior ${stat.details.priorMarginPercent.toFixed(1)}% (revenue ${stat.details.revenueGrowthPercent >= 0 ? '+' : ''}${stat.details.revenueGrowthPercent.toFixed(1)}%, expenses ${stat.details.expenseGrowthPercent >= 0 ? '+' : ''}${stat.details.expenseGrowthPercent.toFixed(1)}%, relevance: ${score.toFixed(2)})`;
    }
    case StatType.SeasonalProjection:
      return `- [${category}] Seasonal Projection: ${stat.details.projectedMonth} estimated at $${usd.format(stat.details.projectedAmount)} based on ${stat.details.basisMonths.join(', ')} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    case StatType.CashFlow:
      return `- [Overall] Cash Flow: ${stat.details.direction} — net ${usdSigned(stat.details.monthlyNet)}/mo over ${stat.details.trailingMonths} months (${stat.details.monthsBurning} burning, relevance: ${score.toFixed(2)})`;
    case StatType.Runway: {
      const cash = `$${usd.format(stat.details.cashOnHand)}`;
      const asOf = stat.details.cashAsOfDate.slice(0, 10); // YYYY-MM-DD
      return `- [Overall] Runway: ${stat.details.runwayMonths.toFixed(1)} months — net ${usdSigned(stat.details.monthlyNet)}/mo, cash ${cash} as of ${asOf} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.BreakEven: {
      const be = `$${usd.format(stat.details.breakEvenRevenue)}`;
      const cur = `$${usd.format(stat.details.currentMonthlyRevenue)}`;
      return `- [Overall] Break-Even: ${be}/mo at ${stat.details.marginPercent.toFixed(1)}% margin — current revenue ${cur}/mo, gap ${usdMinus(stat.details.gap)} (confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
    case StatType.CashForecast: {
      const chain = [stat.details.startingBalance, ...stat.details.projectedMonths.map((p) => p.projectedBalance)]
        .map(usdMinus)
        .join(' → ');
      const crossing = stat.details.crossesZeroAtMonth !== null
        ? ` — balance crosses zero around month ${stat.details.crossesZeroAtMonth}`
        : '';
      return `- [Overall] Cash Forecast: balance ${chain} over next 3 months${crossing} (method: ${stat.details.method}, confidence: ${stat.details.confidence}, relevance: ${score.toFixed(2)})`;
    }
  }
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
    allowedStatIds: string;
    categoryCount: string;
    insightCount: string;
  },
): string {
  return template
    .replace('{{statSummaries}}', vars.statSummaries)
    .replace('{{today}}', vars.today)
    .replace('{{businessContext}}', vars.businessContext)
    .replace('{{industryBenchmarks}}', vars.benchmarks)
    .replace('{{statTypeList}}', vars.statTypeList)
    .replace('{{allowedStatIds}}', vars.allowedStatIds)
    .replace('{{categoryCount}}', vars.categoryCount)
    .replace('{{insightCount}}', vars.insightCount);
}

export function assemblePrompt(
  insights: ScoredInsight[],
  promptVersion = DEFAULT_VERSION,
  businessProfile?: BusinessProfile | null,
  now: Date = new Date(),
): AssembledContext {
  const template = getTemplate(promptVersion);
  const businessContext = formatBusinessContext(businessProfile);
  const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const benchmarks = getIndustryBenchmarks(businessProfile?.businessType) ?? 'No industry benchmarks available.';

  if (insights.length === 0) {
    const user = renderUser(template.user, {
      statSummaries:
        'No statistical insights available. The dataset may be empty or too small for meaningful analysis.',
      today,
      businessContext,
      benchmarks,
      statTypeList: 'none',
      allowedStatIds: 'none',
      categoryCount: '0',
      insightCount: '0',
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
      },
    };
  }

  const statSummaries = insights.map(formatStat).join('\n');
  const statTypes = [...new Set(insights.map((i) => i.stat.statType))];
  const allowedStatIds = [...statTypes].sort().join(', ');
  const categories = new Set(insights.map((i) => i.stat.category).filter(Boolean));
  const { breakdown } = insights[0]!;

  const user = renderUser(template.user, {
    statSummaries,
    today,
    businessContext,
    benchmarks,
    statTypeList: statTypes.join(', '),
    allowedStatIds,
    categoryCount: String(categories.size),
    insightCount: String(insights.length),
  });

  const metadata: TransparencyMetadata = {
    statTypes,
    categoryCount: categories.size,
    insightCount: insights.length,
    scoringWeights: breakdown,
    promptVersion,
    generatedAt: now.toISOString(),
  };

  return { system: template.system, user, metadata };
}
