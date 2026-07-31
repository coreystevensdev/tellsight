import { Router, type Response } from 'express';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { alertRulesQueries, orgsQueries, analyticsEventsQueries } from '../db/queries/index.js';
import type { AlertRuleRow } from '../db/queries/alertRules.js';
import { dbAdmin } from '../lib/db.js';
import { verifyMuteToken } from '../jobs/alerts/muteToken.js';
import { RULE_KIND_NOUN_LABELS } from '../jobs/alerts/ruleKindLabels.js';
import { logger } from '../lib/logger.js';

export const publicAlertMuteRouter = Router();

// Bucketed, not permanent: collapses same-click-storm duplicates (two tabs
// hitting the same token within milliseconds of each other). Short window on
// purpose -- a mute -> unmute -> re-mute round trip lands on the same
// eventName+ruleId key if it happens inside the same bucket, which would
// silently drop the second mute's analytics row, so the window only needs to
// outlast a click race, not stay open for legitimate re-mutes.
const MUTE_DEDUPE_WINDOW_MS = 5_000;
function muteDedupeKey(eventName: string, ruleId: number): string {
  return `${eventName}:${ruleId}:${Math.floor(Date.now() / MUTE_DEDUPE_WINDOW_MS)}`;
}

function invalidTokenResponse(res: Response): void {
  res.status(400).json({
    error: { code: 'INVALID_TOKEN', message: 'This mute link has expired or is invalid.' },
  });
}

async function respondWithRuleState(res: Response, rule: AlertRuleRow, muted: boolean): Promise<void> {
  const org = await orgsQueries.findOrgById(rule.orgId);
  res.json({
    data: {
      muted,
      muteUntil: rule.muteUntil ? rule.muteUntil.toISOString() : null,
      ruleKindLabel: RULE_KIND_NOUN_LABELS[rule.kind],
      orgName: org?.name ?? '',
    },
  });
}

// No orgId scope on either route: the HMAC-signed token is the entire
// authorization boundary, same posture as getEnabledByOrgIdsForEvaluation.
// Both mounted without rateLimitPublic, see index.ts.
publicAlertMuteRouter.post('/alerts/mute/:token', async (req, res: Response) => {
  const { token } = req.params;
  const verified = verifyMuteToken(token ?? '');
  if (!verified) {
    logger.warn({ tokenPrefix: (token ?? '').slice(0, 8) }, 'Alert mute token invalid or tampered');
    invalidTokenResponse(res);
    return;
  }

  const rule = await alertRulesQueries.muteViaToken(verified.ruleId, dbAdmin);
  if (!rule) {
    invalidTokenResponse(res);
    return;
  }

  analyticsEventsQueries
    .recordEvent(
      rule.orgId,
      rule.createdByUserId,
      ANALYTICS_EVENTS.ALERT_MUTED,
      { muteUntil: rule.muteUntil },
      dbAdmin,
      muteDedupeKey(ANALYTICS_EVENTS.ALERT_MUTED, rule.id),
    )
    .catch((err) => logger.error({ err, ruleId: rule.id }, 'Failed to record alert.muted event'));

  req.log.info({ orgId: rule.orgId, ruleId: rule.id, action: 'muted' }, 'Alert rule muted via email link');

  await respondWithRuleState(res, rule, true);
});

publicAlertMuteRouter.post('/alerts/unmute/:token', async (req, res: Response) => {
  const { token } = req.params;
  const verified = verifyMuteToken(token ?? '');
  if (!verified) {
    logger.warn({ tokenPrefix: (token ?? '').slice(0, 8) }, 'Alert unmute token invalid or tampered');
    invalidTokenResponse(res);
    return;
  }

  const rule = await alertRulesQueries.unmuteViaToken(verified.ruleId, dbAdmin);
  if (!rule) {
    invalidTokenResponse(res);
    return;
  }

  analyticsEventsQueries
    .recordEvent(
      rule.orgId,
      rule.createdByUserId,
      ANALYTICS_EVENTS.ALERT_UNMUTED,
      { muteUntil: null },
      dbAdmin,
      muteDedupeKey(ANALYTICS_EVENTS.ALERT_UNMUTED, rule.id),
    )
    .catch((err) => logger.error({ err, ruleId: rule.id }, 'Failed to record alert.unmuted event'));

  req.log.info({ orgId: rule.orgId, ruleId: rule.id, action: 'unmuted' }, 'Alert rule unmuted via email link');

  await respondWithRuleState(res, rule, false);
});
