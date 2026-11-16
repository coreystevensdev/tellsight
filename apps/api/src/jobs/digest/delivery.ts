import { ANALYTICS_EVENTS } from 'shared/constants';

import type { DigestRecipient } from '../../db/queries/digestEligibility.js';
import type { DigestValence } from '../../db/queries/digestHistory.js';
import {
  agentProposalsQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
} from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { trackEventOrg } from '../../services/analytics/trackEvent.js';
import type { ComputedStat } from '../../services/curation/types.js';
import type { FirstTimeMilestone } from './firstTimeMilestones.js';
import type { TransitionMilestone } from './milestones.js';
import { getSendQueue, JOB_PREFIX_SEND, type SendJobData } from './queue.js';

const SEND_JOB_ATTEMPTS = 3;
const SEND_JOB_BACKOFF_MS = 30_000;

function sendJobName(userId: number, weekStart: Date): string {
  return `${JOB_PREFIX_SEND}-${userId}-${weekStart.getTime()}`;
}

interface EnqueueDigestSendsInput {
  recipients: DigestRecipient[];
  orgId: number;
  summaryId: number;
  weekStart: Date;
  orgName: string;
  subjectLine: string;
  agentBullets: string[];
  chartKind?: 'runway' | 'cash-flow' | 'margin' | null;
  correlationId: string;
}

export interface DigestEnqueueResult {
  enqueued: number;
  enqueueFailures: number;
}

export async function enqueueDigestSends({
  recipients,
  orgId,
  summaryId,
  weekStart,
  orgName,
  subjectLine,
  agentBullets,
  chartKind,
  correlationId,
}: EnqueueDigestSendsInput): Promise<DigestEnqueueResult> {
  const queue = getSendQueue();
  let enqueued = 0;
  let enqueueFailures = 0;

  for (const recipient of recipients) {
    const data: SendJobData = {
      userId: recipient.userId,
      orgId,
      summaryId,
      weekStart,
      userEmail: recipient.email,
      orgName,
      subjectLine,
      agentBullets,
      ...(chartKind ? { chartKind } : {}),
      correlationId,
    };

    try {
      // BullMQ dedupes on jobId, not the `name` argument. A retried per-org
      // attempt must reuse this id or it will enqueue every recipient again.
      const jobId = sendJobName(recipient.userId, weekStart);
      await queue.add(jobId, data, {
        jobId,
        attempts: SEND_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_MS },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 30 * 86_400 },
      });
      enqueued++;
    } catch (err) {
      enqueueFailures++;
      logger.error(
        { correlationId, orgId, userId: recipient.userId, outcome: 'enqueue_failure', err },
        'Failed to enqueue digest-send job, continuing',
      );
    }
  }

  return { enqueued, enqueueFailures };
}

interface PersistDigestDeliveryInput {
  orgId: number;
  datasetId: number;
  summaryId: number;
  weekStart: Date;
  subjectLine: string;
  stateSentence: string;
  valence: DigestValence;
  currentStats: ComputedStat[];
  firstTimeMilestones: FirstTimeMilestone[];
  transitionMilestones: TransitionMilestone[];
  notifiedProposalIds: number[];
  enqueued: number;
  correlationId: string;
}

// Sends are already queued when this runs, so persistence failures are logged
// rather than rethrowing and causing BullMQ to enqueue duplicate emails.
export async function persistDigestDelivery({
  orgId,
  datasetId,
  summaryId,
  weekStart,
  subjectLine,
  stateSentence,
  valence,
  currentStats,
  firstTimeMilestones,
  transitionMilestones,
  notifiedProposalIds,
  enqueued,
  correlationId,
}: PersistDigestDeliveryInput): Promise<void> {
  // enqueued 0 means nobody received this digest, so there is nothing to
  // record. digest_history.sent_at is not nullable and (org_id, week_start)
  // is unique, so a row here claims a send that never happened and blocks the
  // week from ever being retried. awardMilestone is worse: (org_id, kind) is
  // unique, so an all-time first spent on an undelivered email is just gone.
  // Org 2 lost first_profitable_month and first_break_even this way 2026-11-01.
  if (enqueued === 0) {
    logger.warn(
      {
        correlationId,
        orgId,
        weekStart,
        milestoneKinds: firstTimeMilestones.map((milestone) => milestone.kind),
        notifiedProposalIds,
      },
      'Digest reached nobody, skipping history, milestone awards and notify',
    );
    // Beside the warn, not instead of it. A deploy recreates the api container
    // and takes its logs with it, which is the whole reason the three early
    // returns in perOrg.ts emit this too. A guard that stopped an irreversible
    // write deserves a record that outlives the container.
    //
    // 'no_recipients' is exact rather than a guess: perOrg throws on the
    // all-enqueues-failed case before calling this, so zero enqueued here means
    // an empty audience. A second caller that does not throw would make this
    // reason wrong, and would be the thing to revisit.
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'no_recipients',
      weekStart: weekStart.toISOString(),
      milestoneKinds: firstTimeMilestones.map((milestone) => milestone.kind),
    });
    return;
  }

  try {
    await dbAdmin.transaction(async (tx) => {
      await digestHistoryQueries.saveDigestHistory(
        {
          orgId,
          datasetId,
          summaryId,
          weekStart,
          subjectLine,
          stateSentence,
          valence,
          keyStats: currentStats,
          milestones: [
            ...firstTimeMilestones.map((milestone) => ({
              kind: milestone.kind,
              label: milestone.label,
              catalog: 'first_time' as const,
            })),
            ...transitionMilestones.map((milestone) => ({
              kind: milestone.kind,
              label: milestone.label,
              catalog: 'transition' as const,
            })),
          ],
          sentAt: new Date(),
        },
        tx,
      );

      for (const milestone of firstTimeMilestones) {
        await milestoneAwardsQueries.awardMilestone({ orgId, kind: milestone.kind, datasetId }, tx);
      }

      await agentProposalsQueries.markNotified(orgId, notifiedProposalIds, tx);
    });
  } catch (err) {
    logger.error(
      {
        correlationId,
        orgId,
        weekStart,
        milestoneKinds: firstTimeMilestones.map((milestone) => milestone.kind),
        err,
      },
      'Failed to save digest history and award milestones, continuing',
    );
  }
}
