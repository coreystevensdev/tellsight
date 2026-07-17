import { createElement } from 'react';
import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { env } from '../../../config.js';
import { Sentry } from '../../../lib/sentry.js';
import { sendEmail, EmailSendError } from '../../../services/email/index.js';
import type { SendJobData } from '../queue.js';

const TEMPLATE_VERSION = 'alert-minimal-v1';

// Story 10.3 replaces this body with the real React Email template (chart,
// CAN-SPAM footer, mute link); this story only proves the queue delivers.
const RULE_KIND_LABELS: Record<string, string> = {
  runway_runs_short: 'Your cash runway is running short',
  margin_drops: 'Your profit margin has dropped',
  cash_burn_spikes: 'Your cash burn rate has spiked',
  breakeven_gap_widens: 'Your break-even gap has widened',
  anomaly_fires: 'An unusual transaction pattern was detected',
};

function buildDashboardUrl(datasetId: number): string {
  const url = new URL('/dashboard', env.APP_URL);
  url.searchParams.set('datasetId', String(datasetId));
  return url.toString();
}

function alertPlaintextBody(data: SendJobData, dashboardUrl: string) {
  const headline = RULE_KIND_LABELS[data.ruleKind] ?? 'An alert rule fired';
  return createElement(
    'div',
    null,
    createElement('p', null, `${headline} for ${data.orgName}.`),
    createElement('p', null, `Current value: ${data.currentValue.toFixed(2)}`),
    createElement('p', null, createElement('a', { href: dashboardUrl }, 'View your dashboard')),
  );
}

/**
 * Minimal send handler. Proves the pipeline end to end (fire row -> queue ->
 * email) with a plaintext body; no chart, no CAN-SPAM footer, no mute link,
 * those land in Stories 10.3/10.4 without touching this queue wiring.
 */
export async function handleSendJob(job: Job): Promise<void> {
  const data = job.data as SendJobData;
  const { orgId, userEmail, ruleId, ruleKind, fireId, trigger, correlationId } = data;
  const start = Date.now();

  await Sentry.withScope(async (scope) => {
    scope.setTag('org_id', String(orgId));
    scope.setTag('rule_id', String(ruleId));
    scope.setTag('rule_kind', ruleKind);
    scope.setTag('template_version', TEMPLATE_VERSION);

    const dashboardUrl = buildDashboardUrl(data.datasetId);

    try {
      const result = await sendEmail({
        to: userEmail,
        subject: RULE_KIND_LABELS[ruleKind] ?? 'Tellsight alert',
        react: alertPlaintextBody(data, dashboardUrl),
        tags: { template: TEMPLATE_VERSION, org_id: String(orgId), rule_id: String(ruleId) },
        correlationId,
      });

      logger.info(
        {
          correlationId,
          orgId,
          ruleId,
          ruleKind,
          fireId,
          trigger,
          outcome: 'fired',
          providerMessageId: result.providerMessageId,
          durationMs: Date.now() - start,
        },
        'Alert send complete',
      );
    } catch (err) {
      // Only a non-retryable EmailSendError (bad address, provider rejected
      // the content) is a true terminal failure. Anything else -- a bug here,
      // an unwrapped provider exception, a transient error that wasn't
      // classified -- must still surface as a job failure so BullMQ retries
      // it instead of silently dropping the alert.
      const isTerminal = err instanceof EmailSendError && !err.retryable;
      if (!isTerminal) {
        logger.warn(
          {
            correlationId,
            orgId,
            ruleId,
            ruleKind,
            fireId,
            trigger,
            outcome: 'error',
            durationMs: Date.now() - start,
            err: err instanceof Error ? err.message : String(err),
            providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : undefined,
          },
          'Alert send failure, BullMQ will retry',
        );
        throw err;
      }

      logger.error(
        {
          correlationId,
          orgId,
          ruleId,
          ruleKind,
          fireId,
          trigger,
          outcome: 'error',
          err,
          providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : undefined,
          durationMs: Date.now() - start,
        },
        'Alert send terminal failure',
      );
    }
  });
}
