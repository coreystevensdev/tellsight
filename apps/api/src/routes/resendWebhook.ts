import { Router, type Request, type Response } from 'express';
import express from 'express';
import { Webhook } from 'svix';
import { z } from 'zod';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { env } from '../config.js';
import { logger } from '../lib/logger.js';
import { redactRecipient } from '../services/email/providers/console.js';
import { trackEvent, trackEventSystem } from '../services/analytics/trackEvent.js';

export const resendWebhookRouter = Router();

// svix 2 changed Webhook.verify() to return undefined: it checks the signature
// and tells you nothing about the body. So the body has to be parsed here, and
// once we are parsing it anyway it may as well be validated. The old code cast
// the return straight to ResendEvent, which meant a signature-valid payload
// with, say, a string where tags should be an array reached tags.find and threw.
const resendEventSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      to: z.union([z.string(), z.array(z.string())]).optional(),
      from: z.string().optional(),
      subject: z.string().optional(),
      tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      bounce: z.object({ type: z.string().optional(), subType: z.string().optional(), message: z.string().optional() }).optional(),
      complaint: z.object({ complaintFeedbackType: z.string().optional() }).optional(),
    })
    .optional(),
});

type ResendEvent = z.infer<typeof resendEventSchema>;

function tagValue(tags: { name: string; value: string }[] | undefined, name: string): string | null {
  return tags?.find((t) => t.name === name)?.value ?? null;
}

function parseTagInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function firstRecipient(to: string | string[] | undefined): string | null {
  if (!to) return null;
  return Array.isArray(to) ? to[0] ?? null : to;
}

function emit(
  eventName: typeof ANALYTICS_EVENTS.EMAIL_BOUNCED | typeof ANALYTICS_EVENTS.EMAIL_COMPLAINED,
  metadata: Record<string, unknown>,
  orgId: number | null,
  userId: number | null,
): void {
  if (orgId !== null && userId !== null) {
    trackEvent(orgId, userId, eventName, metadata);
  } else {
    trackEventSystem(eventName, metadata);
  }
}

resendWebhookRouter.post(
  '/webhooks/resend',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    if (!env.RESEND_WEBHOOK_SECRET) {
      logger.warn('Resend webhook hit but RESEND_WEBHOOK_SECRET is unset, rejecting');
      res.status(400).json({
        error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook is not configured for signature verification' },
      });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }

    const raw = req.body.toString('utf8');
    const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
    try {
      wh.verify(raw, headers);
    } catch (err) {
      logger.warn({ err }, 'Resend webhook signature verification failed');
      res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
      return;
    }

    const parsed = resendEventSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      // 200, not 400. The signature was good, so this came from Resend, and a
      // retry of the same body parses exactly the same way. Answering 4xx here
      // would buy an infinite redelivery loop over a shape we were never going
      // to act on. Same posture as an event type we do not handle.
      logger.warn(
        { provider: 'resend', issues: parsed.error.issues },
        'Resend webhook passed signature check but did not match the expected shape, ignoring',
      );
      res.json({ received: true });
      return;
    }
    const event: ResendEvent = parsed.data;

    const data = event.data ?? {};
    const tags = data.tags;
    const orgId = parseTagInt(tagValue(tags, 'org_id'));
    const userId = parseTagInt(tagValue(tags, 'user_id'));
    const template = tagValue(tags, 'template') ?? 'unknown';
    const recipientRaw = firstRecipient(data.to);
    const recipient = recipientRaw ? String(redactRecipient(recipientRaw)) : null;
    const messageId = data.email_id ?? null;

    if (event.type === 'email.bounced') {
      emit(
        ANALYTICS_EVENTS.EMAIL_BOUNCED,
        {
          messageId,
          recipientEmail: recipient,
          template,
          bounceType: data.bounce?.type ?? null,
          bounceSubType: data.bounce?.subType ?? null,
          bouncedAt: event.created_at ?? new Date().toISOString(),
        },
        orgId,
        userId,
      );
      logger.info(
        { provider: 'resend', eventType: event.type, messageId, recipient, template, orgId, userId },
        'Resend bounce event recorded',
      );
    } else if (event.type === 'email.complained') {
      emit(
        ANALYTICS_EVENTS.EMAIL_COMPLAINED,
        {
          messageId,
          recipientEmail: recipient,
          template,
          complaintType: data.complaint?.complaintFeedbackType ?? null,
          complainedAt: event.created_at ?? new Date().toISOString(),
        },
        orgId,
        userId,
      );
      logger.info(
        { provider: 'resend', eventType: event.type, messageId, recipient, template, orgId, userId },
        'Resend complaint event recorded',
      );
    } else {
      logger.debug({ provider: 'resend', eventType: event.type, messageId }, 'Resend event ignored (not bounce/complaint)');
    }

    res.json({ received: true });
  },
);
