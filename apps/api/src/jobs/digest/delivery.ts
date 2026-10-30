import type { DigestRecipient } from '../../db/queries/digestEligibility.js';
import type { DigestValence } from '../../db/queries/digestHistory.js';
import {
  agentProposalsQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
} from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
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

      // Empty recipient lists and total enqueue failure mean nobody saw the
      // proposal bullets, so leave them pending for the next digest.
      if (enqueued > 0) {
        await agentProposalsQueries.markNotified(orgId, notifiedProposalIds, tx);
      }
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
