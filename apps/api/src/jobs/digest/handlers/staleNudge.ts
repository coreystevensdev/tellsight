import type { Job } from 'bullmq';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { logger } from '../../../lib/logger.js';
import { env } from '../../../config.js';
import { sendEmail, EmailSendError } from '../../../services/email/index.js';
import { digestEligibilityQueries } from '../../../db/queries/index.js';
import { trackEvent } from '../../../services/analytics/trackEvent.js';
import { StaleNudge, buildUploadUrl } from '../templates/staleNudge.js';
import { buildUnsubscribeUrl } from '../templates/digestWeekly.js';
import { buildListUnsubscribeHeaders } from './perSend.js';
import { nudgeJobDataSchema } from '../queue.js';

const TEMPLATE_VERSION = 'stale-nudge-v1';
const SUBJECT = 'Your weekly digest has paused';

function daysSince(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Tells an org, once, that its weekly digest has stopped because nothing new
 * has arrived. The sweep that enqueues this already filtered on "not told yet",
 * so reaching here means send.
 */
export async function handleStaleNudgeJob(job: Job): Promise<void> {
  const { orgId, orgName, datasetCreatedAt, correlationId } = nudgeJobDataSchema.parse(job.data);
  const start = Date.now();

  const recipients = await digestEligibilityQueries.findOrgNudgeRecipients(orgId);
  if (recipients.length === 0) {
    // Every member turned the digest off between the sweep and now. Nothing to
    // send and nothing to record: leaving the column null costs one wasted
    // query next week, while stamping it would suppress a real notice later.
    logger.info({ correlationId, orgId, outcome: 'skipped', reason: 'no_recipients' }, 'Stale nudge skipped');
    return;
  }

  const uploadUrl = buildUploadUrl();
  const daysSinceData = daysSince(datasetCreatedAt, new Date());
  let sent = 0;
  const failures: number[] = [];

  for (const recipient of recipients) {
    const unsubscribeUrl = buildUnsubscribeUrl(recipient.userId);
    try {
      const result = await sendEmail({
        to: recipient.email,
        subject: SUBJECT,
        react: StaleNudge({
          orgName,
          daysSinceData,
          uploadUrl,
          unsubscribeUrl,
          mailingAddress: env.EMAIL_MAILING_ADDRESS,
          companyName: env.EMAIL_FROM_NAME,
        }),
        tags: { template: TEMPLATE_VERSION, org_id: String(orgId), user_id: String(recipient.userId) },
        headers: buildListUnsubscribeHeaders(unsubscribeUrl),
        correlationId,
      });
      sent += 1;
      trackEvent(orgId, recipient.userId, ANALYTICS_EVENTS.DIGEST_PAUSED_NOTICE_SENT, {
        templateVersion: TEMPLATE_VERSION,
        daysSinceData,
        providerMessageId: result.providerMessageId,
      });
    } catch (err) {
      failures.push(recipient.userId);
      logger.error(
        {
          correlationId,
          orgId,
          userId: recipient.userId,
          err,
          providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : null,
        },
        'Stale nudge send failed for one recipient',
      );
    }
  }

  // Stamped when anyone got it, not when everyone did. The column answers "has
  // this org been told", and one permanently bouncing address should not re-send
  // to every other member week after week. Individual failures are loud above.
  if (sent > 0) {
    await digestEligibilityQueries.markStaleNudgeSent(orgId, new Date());
  }

  logger.info(
    { correlationId, orgId, sent, failed: failures.length, daysSinceData, durationMs: Date.now() - start },
    'Stale nudge complete',
  );
}
