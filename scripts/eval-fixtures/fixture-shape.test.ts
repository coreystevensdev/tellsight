import { describe, it, expect } from 'vitest';

import { FIXTURES } from './fixtures.js';
import { hasValidDiscriminatorFields } from '../../apps/api/src/services/curation/statIdentity.js';

// The third guard over these fixtures, after arithmetic and dates. Those two ask
// whether the numbers could have been computed and whether the dates could have
// happened. This one asks whether production would accept the stat at all.
//
// These are hand-written, so their field values come from an idea of the shape
// rather than from real output, and four were found wrong in one day: a
// year-over-year month of '2025-11' where computeYearOverYear writes
// MONTH_NAMES[month] and emits 'Nov', a 'January' in statId.test.ts for the same
// reason, a digest jsonb fixture calling an entry valid while missing the field
// the discriminator reads, and trend windows dated after the clock the eval hands
// the model.
//
// hasValidDiscriminatorFields is the production validator: digestHistory's
// isComputedStat runs it on every keyStats entry before casting jsonb, so a
// fixture it rejects is a fixture describing a stat that would be dropped on the
// way back out of the database.
describe('eval fixture shape', () => {
  it('every stat survives the guard production runs on stored stats', () => {
    const rejected = FIXTURES.flatMap((fixture) =>
      fixture
        .build()
        .filter((stat) => !hasValidDiscriminatorFields({ statType: stat.statType, details: stat.details }))
        .map(
          (stat) =>
            `${fixture.id}/${stat.statType}/${stat.category ?? '_'}: ${JSON.stringify(stat.details)}`,
        ),
    );

    expect(
      rejected,
      'these fixture stats carry field values production would reject, so the eval is scoring a prompt it cannot produce',
    ).toEqual([]);
  });
});
