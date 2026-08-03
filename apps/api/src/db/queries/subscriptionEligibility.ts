import { and, eq, gt, isNotNull } from 'drizzle-orm';

import { subscriptions } from '../schema.js';

/**
 * A canceled subscription still counts as entitled until its paid period
 * ends. Shared by every eligibility check that needs to fold those orgs
 * back in: getActiveTier/getAgentEnabled (subscriptions.ts) and the
 * agent/alert/digest cron sweep builders. `asOf` is the caller's pinned
 * "now" so a single paginated sweep can't have an org's eligibility flip
 * between pages.
 */
export function canceledWithGracePeriod(asOf: Date) {
  return and(
    eq(subscriptions.status, 'canceled'),
    isNotNull(subscriptions.currentPeriodEnd),
    gt(subscriptions.currentPeriodEnd, asOf),
  );
}
