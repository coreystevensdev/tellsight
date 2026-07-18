import { Router } from 'express';
import { z } from 'zod';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { verifyAlertTrackingToken } from '../jobs/alerts/trackingToken.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';

export const alertTrackingRouter = Router();

const clickBodySchema = z.object({ token: z.string().min(1) });

// POST /track/alert/click  body: { token }
//
// Always returns 200 { ok: true } on every failure mode (missing body, wrong
// shape, bad signature), same defense-in-depth posture as digest's click
// route: a 400 on shape would let a scanner probe for the expected body.
alertTrackingRouter.post('/track/alert/click', (req, res) => {
  const parsed = clickBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: true });
    return;
  }

  const verified = verifyAlertTrackingToken(parsed.data.token);
  if (!verified) {
    logger.debug({ tokenPrefix: parsed.data.token.slice(0, 8) }, 'Alert click: token invalid');
    res.status(200).json({ ok: true });
    return;
  }

  trackEvent(verified.orgId, verified.userId, ANALYTICS_EVENTS.ALERT_CLICKED, {
    ruleId: verified.ruleId,
    ruleKind: verified.ruleKind,
    fireId: verified.fireId,
    destination: '/dashboard',
  });

  logger.info(
    {
      orgId: verified.orgId,
      userId: verified.userId,
      ruleId: verified.ruleId,
      fireId: verified.fireId,
      eventName: ANALYTICS_EVENTS.ALERT_CLICKED,
    },
    'Alert engagement event recorded',
  );

  res.status(200).json({ ok: true });
});
