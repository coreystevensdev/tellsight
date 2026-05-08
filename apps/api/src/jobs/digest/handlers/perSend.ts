import type { Job } from 'bullmq';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { env } from '../../../config.js';
import { aiSummariesQueries, digestPreferencesQueries } from '../../../db/queries/index.js';
import { sendEmail, EmailSendError } from '../../../services/email/index.js';
import { trackEvent } from '../../../services/analytics/trackEvent.js';
import {
  DigestWeekly,
  buildRecipientExplanation,
  parseSummaryToBullets,
  buildDashboardUrl,
  buildUnsubscribeUrl,
} from '../templates/digestWeekly.js';
import type { SendJobData } from '../queue.js';

const TEMPLATE_VERSION = 'digest-weekly-v1';
const SIX_DAYS_MS = 6 * 86_400_000;

/**
 * Per-send handler. Final dedupe race-check against last_sent_at, render the
 * weekly digest template, hand to sendEmail (with List-Unsubscribe headers),
 * mark sent + emit analytics on success. Retryable provider failures re-throw
 * so BullMQ retries; terminal failures emit digest_failed and exit cleanly
 * (no retry, no markSent).
 */
export async function handlePerSendJob(job: Job): Promise<void> {
  const { userId, orgId, summaryId, weekStart, userEmail, orgName, correlationId } =
    job.data as SendJobData;
  const start = Date.now();

  const prefs = await digestPreferencesQueries.upsertDefaults(userId, dbAdmin);
  if (
    prefs.lastSentAt &&
    Date.now() - prefs.lastSentAt.getTime() < SIX_DAYS_MS
  ) {
    logger.info(
      { correlationId, userId, orgId, lastSentAt: prefs.lastSentAt },
      'Per-send skipped: last_sent_at within 6 days (race after orchestrator enqueue)',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'within_dedupe_window',
      lastSentAt: prefs.lastSentAt.toISOString(),
    });
    return;
  }

  if (prefs.cadence === 'off') {
    logger.info(
      { correlationId, userId, orgId },
      'Per-send skipped: cadence flipped to off after fan-out',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.DIGEST_SKIPPED, { reason: 'cadence_off' });
    return;
  }

  const row = await aiSummariesQueries.getById(summaryId, dbAdmin);

  if (!row) {
    logger.error(
      { correlationId, userId, orgId, summaryId },
      'Per-send failed: cached summary missing (deleted between per-org and per-send?)',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.DIGEST_FAILED, {
      reason: 'summary_missing',
      summaryId,
    });
    return;
  }

  const bullets = parseSummaryToBullets(row.content);
  const dashboardUrl = buildDashboardUrl(row.datasetId);
  const unsubscribeUrl = buildUnsubscribeUrl(userId);
  const headers = buildListUnsubscribeHeaders(unsubscribeUrl);

  try {
    const result = await sendEmail({
      to: userEmail,
      subject: `${orgName} weekly insights`,
      react: DigestWeekly({
        orgName,
        bullets,
        dashboardUrl,
        unsubscribeUrl,
        mailingAddress: env.EMAIL_MAILING_ADDRESS,
        companyName: env.EMAIL_FROM_NAME,
      }),
      tags: {
        template: TEMPLATE_VERSION,
        org_id: String(orgId),
        user_id: String(userId),
      },
      headers,
      correlationId,
    });

    await digestPreferencesQueries.markSent(userId, new Date(), dbAdmin);

    trackEvent(orgId, userId, ANALYTICS_EVENTS.DIGEST_SENT, {
      templateVersion: TEMPLATE_VERSION,
      summaryId,
      weekStart: weekStart.toISOString(),
      providerMessageId: result.providerMessageId,
    });

    // canSpamElements is the structured audit trail. Console provider
    // truncates renderedHtmlPreview at 200 chars and the footer sits past
    // that, so the handler logs the footer fields directly.
    logger.info(
      {
        correlationId,
        userId,
        orgId,
        templateVersion: TEMPLATE_VERSION,
        outcome: 'sent',
        providerMessageId: result.providerMessageId,
        durationMs: Date.now() - start,
        canSpamElements: {
          mailingAddress: env.EMAIL_MAILING_ADDRESS,
          unsubscribeUrl,
          recipientExplanation: buildRecipientExplanation(orgName),
          companyName: env.EMAIL_FROM_NAME,
        },
      },
      'Per-send complete',
    );
  } catch (err) {
    if (err instanceof EmailSendError && err.retryable) {
      logger.warn(
        { correlationId, userId, orgId, err: err.message, providerStatusCode: err.providerStatusCode },
        'Per-send retryable failure, BullMQ will retry',
      );
      throw err;
    }

    // Terminal failure: log, emit failure event, exit cleanly so BullMQ doesn't retry.
    logger.error(
      {
        correlationId,
        userId,
        orgId,
        templateVersion: TEMPLATE_VERSION,
        outcome: 'failed',
        err,
        providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : undefined,
        durationMs: Date.now() - start,
      },
      'Per-send terminal failure',
    );
    trackEvent(orgId, userId, ANALYTICS_EVENTS.DIGEST_FAILED, {
      reason: 'send_failed',
      message: err instanceof Error ? err.message : String(err),
      providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : null,
    });
  }
}

// Pair of headers Gmail/Yahoo 2024 sender rules require for one-click
// unsubscribe to count. URL-only per RFC 8058: the mailto: half was dropped
// in Story 9.4 because we don't operate an unsubscribe@<domain> inbox and
// advertising one that bounces is a deliverability footgun.
export function buildListUnsubscribeHeaders(
  unsubscribeUrl: string,
): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
