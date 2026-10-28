import type { ComputedStat, IdentifiedStat } from './types.js';
import { StatType } from './types.js';
import { MONTH_NAMES } from './computationPrimitives.js';

// Per-instance id for the audit drawer and NL Q&A citation system.
// Different from allowedStatTypes (assembly.ts), which refers to stat *types*, not instances.
export function statInstanceId(stat: ComputedStat, datasetId: number): string {
  // Swap for lookalike characters rather than stripping. The quote swap
  // keeps a literal ASCII quote from breaking the <cite id="..."> attribute
  // delimiter downstream (assembly.ts). The colon swap is forward-hardening
  // (DW-32): keeping a literal colon out of category means the id can't be
  // misread by a parser that assumes datasetId:statType:category:discriminator
  // -- expire.ts's Anomaly re-validation sweep (DW-64) is exactly that parser,
  // splitting on ':' to read off the statType segment. Both swaps avoid
  // collapsing two categories that differ only by an escaped character onto
  // the same id, or an escaped-only category onto an empty segment.
  const category =
    stat.category == null ? '_' : stat.category.replace(/"/g, '”').replace(/:/g, '：');
  return `${datasetId}:${stat.statType}:${category}:${statDiscriminator(stat)}`;
}

// digestHistory.ts's isComputedStat calls this on every keyStats entry before
// casting jsonb to ComputedStat, and statDiscriminator (below) dereferences
// the same details fields with no guard of its own. Total and Average also
// dereference details.scope there, but neither is a TrendCarryingStatType so
// compareToPriorPeriods can never match one -- their case is still checked
// here so this guard holds even if that changes. Keep the two switches in
// sync: a stat type added to one and not the other reintroduces the drift
// DW-119 found.
export function hasValidDiscriminatorFields(stat: { statType: string; details: unknown }): boolean {
  const details = stat.details as Record<string, unknown> | null | undefined;
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return typeof details?.scope === 'string';
    case StatType.YearOverYear:
      return (
        typeof details?.currentRevenue === 'number' &&
        Number.isFinite(details.currentRevenue) &&
        typeof details?.month === 'string' &&
        (MONTH_NAMES as readonly string[]).includes(details.month)
      );
    case StatType.SeasonalProjection:
      return typeof details?.projectedMonth === 'string';
    case StatType.CashFlow:
      return typeof details?.trailingMonths === 'number' && Number.isFinite(details.trailingMonths);
    default:
      return true;
  }
}

function statDiscriminator(stat: ComputedStat): string {
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return stat.details.scope;
    case StatType.YearOverYear:
      // Deliberately the revenue figure and not currentYearLabel, even though
      // a year would read better in a citation id. These ids are embedded in
      // stored summaries as <stat id="..."/> and resolveStatById recomputes to
      // match them, so the string has to stay byte-identical to what the old
      // details.currentYear produced. Unique only because computeStats emits
      // one year-over-year window per call; see DW-219.
      return `${stat.details.currentRevenue}-${stat.details.month}`;
    case StatType.SeasonalProjection:
      return stat.details.projectedMonth;
    case StatType.CashFlow:
      return `w${stat.details.trailingMonths}`;
    case StatType.Anomaly:
      // Stays the value even though details.period now exists. These ids are
      // embedded in stored summaries as <stat id="..."/> and resolveStatById
      // recomputes to match them, so widening the discriminator would break the
      // audit drawer on every summary already written.
      return `v${stat.value}`;
    default:
      // trend, category_breakdown, margin_trend, runway, break_even, cash_forecast,
      // category_variance:
      // each producer emits at most one stat per (category, statType), so a fixed
      // placeholder is a safe id. If a producer ever emits more than one, the second
      // instance silently collides and assignIds drops it -- add a real discriminator
      // before that becomes possible.
      return '_';
  }
}

// Shared by resolveStatByType and the Q&A tool registry's digest-history
// matcher, so the two call sites can't drift on what "matches" means.
export function matchesStatShape(
  stat: { statType: StatType; category: string | null },
  statType: StatType,
  category?: string,
): boolean {
  return stat.statType === statType && (category === undefined || stat.category === category);
}

// computeYearOverYear emits one stat per significant month within the current
// year, all sharing (category: 'Revenue', statType: 'year_over_year') --
// statDiscriminator already accounts for this when minting ids. Every other
// producer emits at most one stat per shape, so this only has real work to
// do for year_over_year; array order otherwise reflects a single match.
function mostRecentMatch(matches: ComputedStat[]): ComputedStat {
  let latest = matches[0]!;
  for (const stat of matches) {
    if (stat.statType === StatType.YearOverYear && latest.statType === StatType.YearOverYear) {
      const monthNames: readonly string[] = MONTH_NAMES;
      if (monthNames.indexOf(stat.details.month) > monthNames.indexOf(latest.details.month)) {
        latest = stat;
      }
    }
  }
  return latest;
}

// Same matching rule as matchesStatShape, but resolves ambiguity when more
// than one stat shares (category, statType) instead of returning array order.
export function findMatchingStat<T extends ComputedStat>(
  stats: T[],
  statType: StatType,
  category?: string,
): T | null {
  const matches = stats.filter((stat) => matchesStatShape(stat, statType, category));
  return matches.length > 0 ? (mostRecentMatch(matches) as T) : null;
}

// Maps stats to IdentifiedStat[], deduping byte-identical entries (keeps first).
// Relies on each producer function emitting at most one stat per (category, statType),
// except Anomaly, whose only possible collision is two same-value anomalies in one
// category -- byte-identical (same zScore/deviation) and not citable apart anyway.
// Each stat is deep-cloned before the id is attached, so an IdentifiedStat never
// shares object identity (including nested arrays like CashFlowDetails.recentMonths)
// with the computeStats() output that produced it.
export function assignIds(stats: ComputedStat[], datasetId: number): IdentifiedStat[] {
  const byId = new Map<string, IdentifiedStat>();
  for (const stat of stats) {
    const id = statInstanceId(stat, datasetId);
    if (!byId.has(id)) byId.set(id, { ...structuredClone(stat), id });
  }
  return [...byId.values()];
}
