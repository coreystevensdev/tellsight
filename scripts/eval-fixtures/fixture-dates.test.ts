import { describe, it, expect } from 'vitest';

import { FIXTURES, FROZEN_NOW } from './fixtures.js';
import { MONTH_NAMES } from '../../apps/api/src/services/curation/computationPrimitives.js';
import { StatType } from '../../apps/api/src/services/curation/types.js';
import type { ComputedStat } from '../../apps/api/src/services/curation/types.js';

// The sibling of fixture-arithmetic.test.ts, for the other half nothing graded.
// That file checks a fixture's numbers against the formulas that would produce
// them. This checks its dates against the clock the eval hands the model.
//
// A year-over-year stat reported revenue for 2026-06 while the prompt opened
// with "Today is January 15, 2026", so the only temporal frame the model gets
// contradicted itself, and three of twenty-four rejected claims in the n=30
// seasonal-anomaly run put the December anomaly in the wrong year. Two trend
// windows were then added running five months past the same clock, by anchoring
// to that bad date without checking it.
//
// Projections are exempt by design: a forecast that did not point past today
// would be useless. Everything else describes a period that has closed.

const FROZEN_MONTH = FROZEN_NOW.toISOString().slice(0, 7);

// Narrowed per statType rather than read through a Record cast, so renaming any
// of these fields breaks the build instead of silently emptying the guard.
function closedPeriods(stat: ComputedStat): { field: string; value: string }[] {
  const month = (field: string, value: string) => [{ field, value: value.slice(0, 7) }];

  switch (stat.statType) {
    case StatType.Anomaly:
      return month('period', stat.details.period);
    case StatType.YearOverYear: {
      // details.month is a MONTH_NAMES abbreviation with no year in it, so it
      // cannot be compared to the clock on its own: 'Nov' sorts after '2026-01'
      // because N beats 2 in ASCII. The year lives in currentYearLabel, and the
      // two together are the period this stat reports.
      const i = (MONTH_NAMES as readonly string[]).indexOf(stat.details.month);
      if (i === -1) return [];
      return [
        {
          field: 'currentYearLabel+month',
          value: `${stat.details.currentYearLabel}-${String(i + 1).padStart(2, '0')}`,
        },
      ];
    }
    case StatType.Trend:
      return [
        ...month('firstPeriod', stat.details.firstPeriod),
        ...month('lastPeriod', stat.details.lastPeriod),
      ];
    case StatType.CategoryVariance:
      return month('monthLabel', stat.details.monthLabel);
    case StatType.Runway:
      return month('cashAsOfDate', stat.details.cashAsOfDate);
    case StatType.SeasonalProjection:
      // projectedMonth is the forecast and is allowed ahead of today; the basis
      // months are the history it was derived from.
      return stat.details.basisMonths.map((value, i) => ({
        field: `basisMonths[${i}]`,
        value: value.slice(0, 7),
      }));
    case StatType.CashForecast:
      // projectedMonths likewise point forward on purpose.
      return month('asOfDate', stat.details.asOfDate);
    default:
      return [];
  }
}

describe('eval fixture dates', () => {
  it('has a frozen clock to measure against', () => {
    expect(FROZEN_MONTH).toMatch(/^\d{4}-\d{2}$/);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id} reports no closed period later than ${FROZEN_MONTH}`, () => {
      const offenders = fixture
        .build()
        .flatMap((stat) =>
          closedPeriods(stat).map(({ field, value }) => ({
            stat: `${stat.statType}/${stat.category ?? 'Overall'}`,
            field,
            value,
          })),
        )
        .filter((p) => p.value > FROZEN_MONTH);

      expect(
        offenders,
        `these describe months that have not happened as of ${FROZEN_MONTH}: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    });

    it(`${fixture.id} orders every trend window forwards`, () => {
      const backwards = fixture
        .build()
        .flatMap((s) => (s.statType === StatType.Trend ? [s.details] : []))
        .filter((d) => d.firstPeriod > d.lastPeriod);
      expect(backwards).toEqual([]);
    });
  }
});
