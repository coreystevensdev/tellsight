import type { ComputedStat } from '../../services/curation/types.js';
import type { DigestValence } from '../../db/queries/digestHistory.js';

// Exported so threshold consumers share a single definition and can't drift independently.
export const RUNWAY_CONCERNING_THRESHOLD = 3; // runwayMonths < 3 → concerning
export const RUNWAY_POSITIVE_THRESHOLD = 6; // runwayMonths >= 6 → positive

// Tags a digest with the emotional register its data warrants. Pure: no I/O, no
// side effects. `concerning` has exactly one source, a runway under 3 months,
// because that number is the only signal sharp enough to justify an alarm. Every
// other negative (burning cash, shrinking margin, below break-even, forecast
// crossing zero) is structural, common, and lands as `watching`, not alarm.
// A non-finite runwayMonths fails every comparison and falls through to neutral;
// computation.ts only ever emits a finite number, so this is a defensive floor.
export function classifyValence(stats: readonly ComputedStat[]): DigestValence {
  // Each `.find` narrows to the matching member via TS 5.5+ inferred type
  // predicates ((s) => s.statType === 'x' is read as `s is XStat`), which is what
  // lets `.details.<field>` resolve below. Hoisting these into typed locals or
  // building on TS <5.5 would break that narrowing.
  const runway = stats.find((s) => s.statType === 'runway');

  if (runway && runway.details.runwayMonths < RUNWAY_CONCERNING_THRESHOLD) {
    return 'concerning';
  }

  const cashFlow = stats.find((s) => s.statType === 'cash_flow');
  const margin = stats.find((s) => s.statType === 'margin_trend');
  const breakEven = stats.find((s) => s.statType === 'break_even');
  const forecast = stats.find((s) => s.statType === 'cash_forecast');

  // A runway in the 3-6 band counts as negative here: < 3 already returned above,
  // so this clause only sees the watching tier.
  // Guard styles differ on purpose. cashFlow/margin compare to a string literal, so
  // `?.` is safe (undefined fails the ===). forecast/breakEven need explicit
  // `!== undefined` because `forecast?.…crossesZeroAtMonth !== null` would read true
  // when no forecast exists (undefined !== null), flipping the result. Don't unify these.
  const hasNegative =
    (runway !== undefined && runway.details.runwayMonths < RUNWAY_POSITIVE_THRESHOLD) ||
    cashFlow?.details.direction === 'burning' ||
    margin?.details.direction === 'shrinking' ||
    (breakEven !== undefined && breakEven.details.gap > 0) ||
    (forecast !== undefined && forecast.details.crossesZeroAtMonth !== null);

  if (hasNegative) return 'watching';

  const hasPositive =
    (runway !== undefined && runway.details.runwayMonths >= RUNWAY_POSITIVE_THRESHOLD) ||
    cashFlow?.details.direction === 'surplus' ||
    margin?.details.direction === 'expanding' ||
    (breakEven !== undefined && breakEven.details.gap <= 0) ||
    (forecast !== undefined && forecast.details.crossesZeroAtMonth === null);

  if (hasPositive) return 'positive';

  return 'neutral';
}
