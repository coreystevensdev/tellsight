import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';

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

// weekStart/weekEnd skip validation (z.custom always passes) but keep the
// Date type. BullMQ JSON-serializes them to ISO strings with no
// re-hydration, so a real worker reads a string here, not a Date -- z.date()
// would reject that string and turn today's loud, retry-eligible TypeError
// (from perOrg/perSend calling .getTime()/.toISOString() on a string) into a
// silently completed job instead.
const unvalidatedDate = z.custom<Date>(() => true);

export const orgJobDataSchema = z.object({
  orgId: z.number().int().finite(),
  weekStart: unvalidatedDate,
  weekEnd: unvalidatedDate,
  correlationId: z.string().min(1),
});
export type OrgJobData = z.infer<typeof orgJobDataSchema>;

const FALLBACK_SUBJECT_LINE = 'Your weekly digest';

// Exported so perSend.ts can check "would this subjectLine have fallen back"
// against the same rule sendJobDataSchema uses, instead of re-deriving it.
export const subjectLineSchema = z.string().trim().min(1);

export const sendJobDataSchema = z.object({
  userId: z.number().int().finite(),
  orgId: z.number().int().finite(),
  summaryId: z.number().int().finite(),
  weekStart: unvalidatedDate,
  userEmail: z.string(),
  orgName: z.string(),
  subjectLine: subjectLineSchema.catch(FALLBACK_SUBJECT_LINE),
  correlationId: z.string().min(1),
});
export type SendJobData = z.infer<typeof sendJobDataSchema>;

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
