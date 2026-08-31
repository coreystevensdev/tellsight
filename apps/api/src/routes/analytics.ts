import { Router } from 'express';

import { requireUser } from '../lib/requireUser.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { ANALYTICS_EVENTS, type AnalyticsEventName } from 'shared/constants';

const MAX_METADATA_BYTES = 4096;

const VALID_EVENTS = new Set<string>(Object.values(ANALYTICS_EVENTS));

const analyticsRouter = Router();

analyticsRouter.post('/events', (req, res) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const userId = Number(user.sub);
  const { eventName, metadata } = req.body as {
    eventName: string;
    metadata?: Record<string, unknown>;
  };

  if (!eventName || typeof eventName !== 'string') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'eventName is required' } });
    return;
  }

  if (!VALID_EVENTS.has(eventName)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown event name' } });
    return;
  }

  // eventName is allowlisted above, but metadata is whatever the caller sends
  // and lands in a jsonb column unexamined. Parameterised, so not an injection
  // route, but an authenticated client could still push arbitrarily large blobs
  // into the analytics table. Cap the serialised size rather than schema every
  // event's payload shape, since the whole point of the column is that callers
  // attach different fields per event.
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'metadata must be an object' } });
      return;
    }
    if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'metadata is too large' } });
      return;
    }
  }

  trackEvent(orgId, userId, eventName as AnalyticsEventName, metadata);
  res.json({ data: { ok: true } });
});

export { analyticsRouter };
