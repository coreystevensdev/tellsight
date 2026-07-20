import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import { ALERT_RULE_KINDS } from 'shared/schemas';

import { env } from '../../config.js';
import { StatType } from '../../services/curation/types.js';
import type { ScoredInsight } from '../../services/curation/index.js';

// Same three-queue shape as jobs/digest/queue.ts, for the same reason:
// BullMQ OSS has no job-name routing on a shared queue, so one queue per
// pipeline stage is the only way to give each stage its own concurrency.

export const QUEUE_ORCHESTRATOR = 'alerts-orchestrator';
export const QUEUE_EVALUATE_ORG = 'alerts-evaluate-org';
export const QUEUE_SEND = 'alerts-send';

export const JOB_ORCHESTRATOR = 'alerts-orchestrator';
export const JOB_PREFIX_EVALUATE_ORG = 'alert-evaluate';
export const JOB_PREFIX_SEND = 'alert-send';

const ALERT_TRIGGERS = ['cron', 'on-upload'] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

export const orchestratorJobDataSchema = z.object({
  orgId: z.number().int().finite().optional(),
  datasetId: z.number().int().finite().optional(),
  correlationId: z.string().min(1),
});
export type OrchestratorJobData = z.infer<typeof orchestratorJobDataSchema>;

export const evaluateOrgJobDataSchema = z.object({
  orgId: z.number().int().finite(),
  datasetId: z.number().int().finite().optional(),
  trigger: z.enum(ALERT_TRIGGERS),
  correlationId: z.string().min(1),
});
export type EvaluateOrgJobData = z.infer<typeof evaluateOrgJobDataSchema>;

const KNOWN_STAT_TYPES = new Set<string>(Object.values(StatType));

// Real shape check, not z.object({}).passthrough(): a bare {} or a stat with
// an unrecognized statType gets caught here instead of throwing later inside
// chart/prompt building. `details` is only checked for presence -- the full
// per-statType detail shape lives in curation/types.ts and isn't worth
// duplicating in a job-payload guard. z.custom<ScoredInsight> (not a z.object
// mirror) so send.ts's existing statType narrowing on insight.stat keeps
// working unchanged downstream.
function isScoredInsight(candidate: unknown): candidate is ScoredInsight {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const { stat, score, breakdown } = candidate as Record<string, unknown>;

  if (typeof stat !== 'object' || stat === null) return false;
  const { statType, category, value, details } = stat as Record<string, unknown>;
  if (typeof statType !== 'string' || !KNOWN_STAT_TYPES.has(statType)) return false;
  if (category !== null && typeof category !== 'string') return false;
  if (!Number.isFinite(value)) return false;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return false;

  if (!Number.isFinite(score)) return false;
  if (typeof breakdown !== 'object' || breakdown === null) return false;
  const { novelty, actionability, specificity } = breakdown as Record<string, unknown>;
  return Number.isFinite(novelty) && Number.isFinite(actionability) && Number.isFinite(specificity);
}

const scoredInsightSchema = z.custom<ScoredInsight>(isScoredInsight, {
  message: 'firedInsight must be a ScoredInsight with a known statType',
});

export const sendJobDataSchema = z.object({
  orgId: z.number().int().finite(),
  orgName: z.string(),
  userId: z.number().int().finite(),
  userEmail: z.string(),
  datasetId: z.number().int().finite(),
  ruleId: z.number().int().finite(),
  ruleKind: z.enum(ALERT_RULE_KINDS),
  fireId: z.number().int().finite(),
  currentValue: z.number().finite(),
  // The single insight matching the fired rule's StatType, already computed
  // by evaluateOrg's runCurationPipeline call. Forwarded here so send.ts
  // doesn't re-run curation for chart data and the LLM prompt input.
  firedInsight: scoredInsightSchema,
  trigger: z.enum(ALERT_TRIGGERS),
  correlationId: z.string().min(1),
});
export type SendJobData = z.infer<typeof sendJobDataSchema>;

let orchestratorQueue: Queue | null = null;
let evaluateOrgQueue: Queue | null = null;
let sendQueue: Queue | null = null;

export function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export function getOrchestratorQueue(): Queue {
  if (!orchestratorQueue) {
    orchestratorQueue = new Queue(QUEUE_ORCHESTRATOR, { connection: connectionOptions() });
  }
  return orchestratorQueue;
}

export function getEvaluateOrgQueue(): Queue {
  if (!evaluateOrgQueue) {
    evaluateOrgQueue = new Queue(QUEUE_EVALUATE_ORG, { connection: connectionOptions() });
  }
  return evaluateOrgQueue;
}

export function getSendQueue(): Queue {
  if (!sendQueue) {
    sendQueue = new Queue(QUEUE_SEND, { connection: connectionOptions() });
  }
  return sendQueue;
}

const UPLOAD_JOB_ATTEMPTS = 3;
const UPLOAD_JOB_BACKOFF_MS = 30_000;

/**
 * One-shot on-upload trigger, called from the dataset confirm route. `jobId`
 * (not just the job name, which BullMQ does not dedupe on) keeps a
 * duplicate confirm request -- retry, double click -- from fanning out two
 * evaluations for the same dataset.
 */
export async function enqueueOnUploadCheck(orgId: number, datasetId: number, correlationId: string): Promise<void> {
  const data: OrchestratorJobData = { orgId, datasetId, correlationId };
  const jobId = `${JOB_ORCHESTRATOR}-upload-${orgId}-${datasetId}`;
  await getOrchestratorQueue().add(jobId, data, {
    jobId,
    attempts: UPLOAD_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: UPLOAD_JOB_BACKOFF_MS },
    removeOnComplete: { count: 50 },
    removeOnFail: { age: 30 * 86_400 },
  });
}

// Test-only: drop singletons so suite teardown can re-init with fresh mocks.
export function resetQueues(): void {
  orchestratorQueue = null;
  evaluateOrgQueue = null;
  sendQueue = null;
}

export async function closeQueues(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (orchestratorQueue) tasks.push(orchestratorQueue.close());
  if (evaluateOrgQueue) tasks.push(evaluateOrgQueue.close());
  if (sendQueue) tasks.push(sendQueue.close());
  await Promise.allSettled(tasks);
  resetQueues();
}
