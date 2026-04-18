import { Router } from 'express';

import { requireUser } from '../lib/requireUser.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { ANALYTICS_EVENTS, type AnalyticsEventName } from 'shared/constants';

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

  trackEvent(orgId, userId, eventName as AnalyticsEventName, metadata);
  res.json({ data: { ok: true } });
});

export { analyticsRouter };
