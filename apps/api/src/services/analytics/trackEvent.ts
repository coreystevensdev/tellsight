import type { AnalyticsEventName } from 'shared/constants';
import { logger } from '../../lib/logger.js';
import { dbAdmin } from '../../lib/db.js';
import { analyticsEventsQueries } from '../../db/queries/index.js';

// dbAdmin: fire-and-forget runs outside any transaction, SET LOCAL context wouldn't apply.
export function trackEvent(
  orgId: number,
  userId: number,
  eventName: AnalyticsEventName,
  metadata?: Record<string, unknown>,
): void {
  analyticsEventsQueries
    .recordEvent(orgId, userId, eventName, metadata, dbAdmin)
    .catch((err) => {
      logger.error({ err, orgId, userId, eventName }, 'Failed to record analytics event');
    });
}

// NULL org/user: RLS excludes these rows from tenant reads; visible only via
// dbAdmin (compliance dashboard, admin feed). Used when webhook context is lost.
export function trackEventSystem(
  eventName: AnalyticsEventName,
  metadata?: Record<string, unknown>,
): void {
  analyticsEventsQueries
    .recordEvent(null, null, eventName, metadata, dbAdmin)
    .catch((err) => {
      logger.error({ err, eventName }, 'Failed to record system analytics event');
    });
}
