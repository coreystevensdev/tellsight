import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';

import { env } from '../../config.js';

// Two queues, not three: the orchestrator pages eligible orgs and fans out
// to evaluate-org, same shape as alerts/digest, but this pipeline never
// sends email itself -- auto_notify findings persist and get picked up by
// the digest fold-in instead, so there's no third send queue here.

export const QUEUE_ORCHESTRATOR = 'agent-orchestrator';
export const QUEUE_EVALUATE_ORG = 'agent-evaluate-org';

export const JOB_ORCHESTRATOR = 'agent-orchestrator';
export const JOB_PREFIX_EVALUATE_ORG = 'agent-eval';

export const orchestratorJobDataSchema = z.object({
  correlationId: z.string().min(1),
});
export type OrchestratorJobData = z.infer<typeof orchestratorJobDataSchema>;

export const evaluateOrgJobDataSchema = z.object({
  orgId: z.number().int().finite(),
  datasetId: z.number().int().finite(),
  correlationId: z.string().min(1),
});
export type EvaluateOrgJobData = z.infer<typeof evaluateOrgJobDataSchema>;

let orchestratorQueue: Queue | null = null;
let evaluateOrgQueue: Queue | null = null;

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

// Test-only: drop singletons so suite teardown can re-init with fresh mocks.
export function resetQueues(): void {
  orchestratorQueue = null;
  evaluateOrgQueue = null;
}

export async function closeQueues(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (orchestratorQueue) tasks.push(orchestratorQueue.close());
  if (evaluateOrgQueue) tasks.push(evaluateOrgQueue.close());
  await Promise.allSettled(tasks);
  resetQueues();
}
