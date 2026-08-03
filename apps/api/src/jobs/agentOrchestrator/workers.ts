import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../lib/logger.js';
import { connectionOptions, QUEUE_ORCHESTRATOR, QUEUE_EVALUATE_ORG } from './queue.js';
import { handleOrchestratorJob } from './handlers/orchestrator.js';
import { handleEvaluateOrgJob } from './handlers/evaluateOrg.js';

const ORCHESTRATOR_CONCURRENCY = 1;
const EVALUATE_ORG_CONCURRENCY = 3;

// Paging + enqueueing is DB/Redis I/O bound, well under a minute even for a
// slow run; 60s leaves headroom without masking a genuinely stuck job.
const ORCHESTRATOR_LOCK_DURATION_MS = 60_000;
// Pinned at BullMQ's own current default (1) so it can't drift if that
// default ever changes upstream, not evidence either worker was tuned away from it.
const ORCHESTRATOR_MAX_STALLED_COUNT = 1;

// generateProposals's Anthropic call alone (claudeClient.ts: timeout 15_000,
// maxRetries 2) can burn up to 45s across attempts before SDK retry backoff
// or the curation pipeline's own DB work are even counted. 180s is generous
// headroom on top of that unmeasured remainder, not a precise budget --
// enough to keep a legitimately slow run from tripping BullMQ's 30s default.
const EVALUATE_ORG_LOCK_DURATION_MS = 180_000;
const EVALUATE_ORG_MAX_STALLED_COUNT = 1;

let orchestratorWorker: Worker | null = null;
let evaluateOrgWorker: Worker | null = null;

function attachStandardListeners(worker: Worker, label: string): void {
  worker.on('failed', (job, err) => {
    logger.error(
      { label, jobId: job?.id, attemptsMade: job?.attemptsMade, err },
      'Agent orchestrator worker job failed',
    );
  });
  worker.on('error', (err) => {
    logger.error({ label, err }, 'Agent orchestrator worker error');
  });
}

export function initAgentOrchestratorWorker(): Worker {
  if (orchestratorWorker) return orchestratorWorker;

  orchestratorWorker = new Worker(QUEUE_ORCHESTRATOR, async (job: Job) => handleOrchestratorJob(job), {
    connection: connectionOptions(),
    concurrency: ORCHESTRATOR_CONCURRENCY,
    lockDuration: ORCHESTRATOR_LOCK_DURATION_MS,
    maxStalledCount: ORCHESTRATOR_MAX_STALLED_COUNT,
  });
  attachStandardListeners(orchestratorWorker, 'orchestrator');
  logger.info({ concurrency: ORCHESTRATOR_CONCURRENCY }, 'Agent orchestrator worker started');
  return orchestratorWorker;
}

export function initAgentEvaluateOrgWorker(): Worker {
  if (evaluateOrgWorker) return evaluateOrgWorker;

  evaluateOrgWorker = new Worker(QUEUE_EVALUATE_ORG, async (job: Job) => handleEvaluateOrgJob(job), {
    connection: connectionOptions(),
    concurrency: EVALUATE_ORG_CONCURRENCY,
    lockDuration: EVALUATE_ORG_LOCK_DURATION_MS,
    maxStalledCount: EVALUATE_ORG_MAX_STALLED_COUNT,
  });
  attachStandardListeners(evaluateOrgWorker, 'evaluate-org');
  logger.info({ concurrency: EVALUATE_ORG_CONCURRENCY }, 'Agent evaluate-org worker started');
  return evaluateOrgWorker;
}

export async function shutdownAgentOrchestratorWorkers(): Promise<void> {
  const tasks: { label: string; close: Promise<unknown> }[] = [];
  if (orchestratorWorker) {
    logger.info({}, 'Closing agent orchestrator worker');
    tasks.push({ label: 'orchestrator', close: orchestratorWorker.close() });
  }
  if (evaluateOrgWorker) {
    logger.info({}, 'Closing agent evaluate-org worker');
    tasks.push({ label: 'evaluate-org', close: evaluateOrgWorker.close() });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.close));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.error({ label: tasks[i]!.label, err: result.reason }, 'Agent orchestrator worker failed to close');
    }
  });

  orchestratorWorker = null;
  evaluateOrgWorker = null;
}
