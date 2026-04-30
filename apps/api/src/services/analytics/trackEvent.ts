import type { AnalyticsEventName } from 'shared/constants';
import { logger } from '../../lib/logger.js';
import { dbAdmin } from '../../lib/db.js';
import { analyticsEventsQueries } from '../../db/queries/index.js';

/**
 * Fire-and-forget event tracker. Logs errors but never throws
 * analytics failures must not block user-facing operations.
 * Uses dbAdmin to bypass RLS, fire-and-forget runs outside any
 * transaction, so SET LOCAL context wouldn't apply anyway.
 */
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
