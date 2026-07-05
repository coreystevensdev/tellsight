import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

import { env } from '../../config.js';

// Three queues, not one. A single shared queue with multiple workers fails
// under BullMQ OSS: there is no native job-name routing, workers compete for
// jobs randomly, and a processor that early-returns marks the job complete
// (hiding it from other workers). Three named queues give independent
// concurrency per job type plus a per-send rate limiter.
//
// Trade-off: three sets of Redis keys, three Worker connections. Cost is
// negligible; benefit is correctness under BullMQ semantics.

export const QUEUE_ORCHESTRATOR = 'digest-orchestrator';
export const QUEUE_ORG = 'digest-org';
export const QUEUE_SEND = 'digest-send';

export const JOB_ORCHESTRATOR = 'digest-orchestrator';
export const JOB_PREFIX_ORG = 'digest-org';
export const JOB_PREFIX_SEND = 'digest-send';

export interface OrchestratorJobData {
  correlationId: string;
}

export interface OrgJobData {
  orgId: number;
  weekStart: Date;
  weekEnd: Date;
  correlationId: string;
}

export interface SendJobData {
  userId: number;
  orgId: number;
  summaryId: number;
  weekStart: Date;
  userEmail: string;
  orgName: string;
  correlationId: string;
}

let orchestratorQueue: Queue | null = null;
let orgQueue: Queue | null = null;
let sendQueue: Queue | null = null;

export function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    // BullMQ requires maxRetriesPerRequest: null on worker connections; safe
    // to apply here too, Queues use the same Redis client shape.
    maxRetriesPerRequest: null,
  };
}

export function getOrchestratorQueue(): Queue {
  if (!orchestratorQueue) {
    orchestratorQueue = new Queue(QUEUE_ORCHESTRATOR, { connection: connectionOptions() });
  }
  return orchestratorQueue;
}

export function getOrgQueue(): Queue {
  if (!orgQueue) {
    orgQueue = new Queue(QUEUE_ORG, { connection: connectionOptions() });
  }
  return orgQueue;
}

export function getSendQueue(): Queue {
  if (!sendQueue) {
    sendQueue = new Queue(QUEUE_SEND, { connection: connectionOptions() });
  }
  return sendQueue;
}

// Test-only: drop singletons so suite teardown can re-init with fresh mocks.
export function resetQueues(): void {
  orchestratorQueue = null;
  orgQueue = null;
  sendQueue = null;
}

export async function closeQueues(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (orchestratorQueue) tasks.push(orchestratorQueue.close());
  if (orgQueue) tasks.push(orgQueue.close());
  if (sendQueue) tasks.push(sendQueue.close());
  await Promise.allSettled(tasks);
  resetQueues();
}
