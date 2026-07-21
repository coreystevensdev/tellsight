import type { IdentifiedStat } from './types.js';
import { StatType } from './types.js';
import { computeCashFlow, marginTrendMonths, monthKey, MONTH_NAMES } from './computation.js';

// Narrower than shared/types' DataRow (drops metadata/orgId/etc), matching
// what the filters below actually read. The index signature is required,
// not decorative: computeCashFlow/marginTrendMonths (computation.ts) take
// their own structurally-identical DataRow with one, and TS treats two
// same-shaped local interfaces as unrelated without it.
interface DataRow {
  id: number;
  category: string;
  parentCategory: string | null;
  date: Date;
  amount: string;
  label: string | null;
  [key: string]: unknown;
}

// Only Income/Expenses rows ever feed a cash-flow or margin-trend number
// (bucketRowsByMonth/marginTrendMonths both ignore every other
// parentCategory), so a row from an unrelated category sharing a window
// month is never "evidence" for that stat, even though its date falls
// inside the window.
function isFinancialRow(row: DataRow): boolean {
  return row.parentCategory === 'Income' || row.parentCategory === 'Expenses';
}

// Maps a resolved stat instance back to the rows that mathematically
// produced its value. Read-only against `stat`: assignIds shallow-copies
// each ComputedStat, so `IdentifiedStat.details` shares object identity
// with the underlying computeStats() output, mutating it here would corrupt
// state other consumers (buildStatDetail, the AI prompt assembly) still read.
export function resolveSourceRows(rows: DataRow[], stat: IdentifiedStat): DataRow[] {
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return stat.category === null ? rows : rows.filter((r) => r.category === stat.category);

    case StatType.Trend:
    case StatType.CategoryBreakdown:
      return rows.filter((r) => r.category === stat.category);

    case StatType.Anomaly:
      return rows.filter((r) => r.category === stat.category && Number(r.amount) === stat.value);

    case StatType.YearOverYear: {
      const { month, currentYearLabel, priorYearLabel } = stat.details;
      return rows.filter((r) => {
        if (r.parentCategory !== 'Income') return false;
        if (MONTH_NAMES[r.date.getMonth()] !== month) return false;
        const year = String(r.date.getFullYear());
        return year === currentYearLabel || year === priorYearLabel;
      });
    }

    case StatType.SeasonalProjection: {
      const basisMonths = new Set(stat.details.basisMonths);
      return rows.filter((r) => {
        if (r.parentCategory !== 'Income') return false;
        return basisMonths.has(`${MONTH_NAMES[r.date.getMonth()]} ${r.date.getFullYear()}`);
      });
    }

    case StatType.CashFlow: {
      const months = new Set(stat.details.recentMonths.map((m) => m.month));
      return rows.filter((r) => isFinancialRow(r) && months.has(monthKey(r.date)));
    }

    case StatType.CashForecast: {
      const months = new Set(stat.details.basisMonths);
      return rows.filter((r) => isFinancialRow(r) && months.has(monthKey(r.date)));
    }

    case StatType.Runway: {
      const cashFlow = computeCashFlow(rows, stat.details.trailingMonths);
      if (cashFlow.length === 0) return [];
      const months = new Set(cashFlow[0]!.details.recentMonths.map((m) => m.month));
      return rows.filter((r) => isFinancialRow(r) && months.has(monthKey(r.date)));
    }

    case StatType.MarginTrend:
    case StatType.BreakEven: {
      const split = marginTrendMonths(rows);
      if (!split) return [];
      const months = new Set([...split.recentMonths, ...split.priorMonths]);
      return rows.filter((r) => isFinancialRow(r) && months.has(monthKey(r.date)));
    }
  }
}
