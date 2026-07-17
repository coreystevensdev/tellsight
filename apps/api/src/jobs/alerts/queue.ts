import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { AlertRuleKind } from 'shared/schemas';

import { env } from '../../config.js';

// Same three-queue shape as jobs/digest/queue.ts, for the same reason:
// BullMQ OSS has no job-name routing on a shared queue, so one queue per
// pipeline stage is the only way to give each stage its own concurrency.

export const QUEUE_ORCHESTRATOR = 'alerts-orchestrator';
export const QUEUE_EVALUATE_ORG = 'alerts-evaluate-org';
export const QUEUE_SEND = 'alerts-send';

export const JOB_ORCHESTRATOR = 'alerts-orchestrator';
export const JOB_PREFIX_EVALUATE_ORG = 'alert-evaluate';
export const JOB_PREFIX_SEND = 'alert-send';

export type AlertTrigger = 'cron' | 'on-upload';

export interface OrchestratorJobData {
  orgId?: number;
  datasetId?: number;
  correlationId: string;
}

export interface EvaluateOrgJobData {
  orgId: number;
  datasetId?: number;
  trigger: AlertTrigger;
  correlationId: string;
}

export interface SendJobData {
  orgId: number;
  orgName: string;
  userEmail: string;
  datasetId: number;
  ruleId: number;
  ruleKind: AlertRuleKind;
  fireId: number;
  currentValue: number;
  trigger: AlertTrigger;
  correlationId: string;
}

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
