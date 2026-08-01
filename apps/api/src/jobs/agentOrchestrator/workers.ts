import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../lib/logger.js';
import { connectionOptions, QUEUE_ORCHESTRATOR, QUEUE_EVALUATE_ORG } from './queue.js';
import { handleOrchestratorJob } from './handlers/orchestrator.js';
import { handleEvaluateOrgJob } from './handlers/evaluateOrg.js';

const ORCHESTRATOR_CONCURRENCY = 1;
const EVALUATE_ORG_CONCURRENCY = 3;

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
  });
  attachStandardListeners(evaluateOrgWorker, 'evaluate-org');
  logger.info({ concurrency: EVALUATE_ORG_CONCURRENCY }, 'Agent evaluate-org worker started');
  return evaluateOrgWorker;
}

export async function shutdownAgentOrchestratorWorkers(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (orchestratorWorker) {
    logger.info({}, 'Closing agent orchestrator worker');
    tasks.push(orchestratorWorker.close());
  }
  if (evaluateOrgWorker) {
    logger.info({}, 'Closing agent evaluate-org worker');
    tasks.push(evaluateOrgWorker.close());
  }
  await Promise.allSettled(tasks);
  orchestratorWorker = null;
  evaluateOrgWorker = null;
}
