import { Router, type Response } from 'express';
import { z } from 'zod';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { verifyDigestTrackingToken } from '../jobs/digest/trackingToken.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';

export const digestTrackingRouter = Router();

// 42-byte transparent 1x1 GIF. Universal across email clients (PNG renders
// inconsistently in older Outlook; SVG is stripped). Same byte sequence used
// by every major email-tracking implementation.
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

// no-store + private prevents corporate/ISP transparent caches from serving
// the same pixel for multiple recipients. Apple's MPP proxy ignores cache
// directives, so this primarily helps non-MPP clients report accurately.
const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'Content-Length': String(TRANSPARENT_GIF.length),
} as const;

function sendPixel(res: Response): void {
  for (const [key, value] of Object.entries(PIXEL_HEADERS)) {
    res.setHeader(key, value);
  }
  res.status(200).end(TRANSPARENT_GIF);
}

// GET /track/digest/open?t=<signed-token>
//
// Always returns the GIF with the same headers regardless of token validity.
// Emitting only on a valid signature avoids leaking validity signal to email
// scanners and click-prefetch bots; same defense-in-depth posture as 9.4's
// unsubscribe POST.
digestTrackingRouter.get('/track/digest/open', (req, res) => {
  const rawToken = typeof req.query.t === 'string' ? req.query.t : '';

  if (!rawToken) {
    sendPixel(res);
    return;
  }

  const verified = verifyDigestTrackingToken(rawToken);
  if (!verified) {
    // Invalid hits are noisy and not actionable, debug level keeps prod logs
    // useful without flooding them with scanner activity.
    logger.debug({ tokenPrefix: rawToken.slice(0, 8) }, 'Digest open: token invalid');
    sendPixel(res);
    return;
  }

  const userAgent = req.get('user-agent') ?? null;
  trackEvent(verified.orgId, verified.userId, ANALYTICS_EVENTS.DIGEST_OPENED, {
    weekStart: verified.weekStart,
    userAgent,
    openedAt: new Date().toISOString(),
  });

  logger.info(
    {
      orgId: verified.orgId,
      userId: verified.userId,
      weekStart: verified.weekStart,
      eventName: ANALYTICS_EVENTS.DIGEST_OPENED,
    },
    'Digest engagement event recorded',
  );

  sendPixel(res);
});

const clickBodySchema = z.object({ token: z.string().min(1) });

// POST /track/digest/click  body: { token }
//
// Always returns 200 { ok: true } on EVERY failure mode (missing body, wrong
// shape, bad signature). A 400 on shape would let a scanner probe for the
// expected body and discover the validation surface, the same defense-in-depth
// posture as the open route's "always returns the GIF".
digestTrackingRouter.post('/track/digest/click', (req, res) => {
  const parsed = clickBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: true });
    return;
  }

  const verified = verifyDigestTrackingToken(parsed.data.token);
  if (!verified) {
    logger.debug(
      { tokenPrefix: parsed.data.token.slice(0, 8) },
      'Digest click: token invalid',
    );
    res.status(200).json({ ok: true });
    return;
  }

  trackEvent(verified.orgId, verified.userId, ANALYTICS_EVENTS.DIGEST_CLICKED, {
    weekStart: verified.weekStart,
    utmCampaign: 'weekly-digest',
    destination: '/dashboard',
  });

  logger.info(
    {
      orgId: verified.orgId,
      userId: verified.userId,
      weekStart: verified.weekStart,
      eventName: ANALYTICS_EVENTS.DIGEST_CLICKED,
    },
    'Digest engagement event recorded',
  );

  res.status(200).json({ ok: true });
});
