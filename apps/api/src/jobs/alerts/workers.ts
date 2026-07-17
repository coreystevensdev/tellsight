import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../lib/logger.js';
import { connectionOptions, QUEUE_ORCHESTRATOR, QUEUE_EVALUATE_ORG, QUEUE_SEND } from './queue.js';
import { handleOrchestratorJob } from './handlers/orchestrator.js';
import { handleEvaluateOrgJob } from './handlers/evaluateOrg.js';
import { handleSendJob } from './handlers/send.js';

const ORCHESTRATOR_CONCURRENCY = 1;
const EVALUATE_ORG_CONCURRENCY = 3;
const SEND_CONCURRENCY = 10;

let orchestratorWorker: Worker | null = null;
let evaluateOrgWorker: Worker | null = null;
let sendWorker: Worker | null = null;

function attachStandardListeners(worker: Worker, label: string): void {
  worker.on('failed', (job, err) => {
    logger.error(
      { label, jobId: job?.id, attemptsMade: job?.attemptsMade, err },
      'Alerts worker job failed',
    );
  });
  worker.on('error', (err) => {
    logger.error({ label, err }, 'Alerts worker error');
  });
}

export function initAlertsOrchestratorWorker(): Worker {
  if (orchestratorWorker) return orchestratorWorker;

  orchestratorWorker = new Worker(QUEUE_ORCHESTRATOR, async (job: Job) => handleOrchestratorJob(job), {
    connection: connectionOptions(),
    concurrency: ORCHESTRATOR_CONCURRENCY,
  });
  attachStandardListeners(orchestratorWorker, 'orchestrator');
  logger.info({ concurrency: ORCHESTRATOR_CONCURRENCY }, 'Alerts orchestrator worker started');
  return orchestratorWorker;
}

export function initAlertsEvaluateOrgWorker(): Worker {
  if (evaluateOrgWorker) return evaluateOrgWorker;

  evaluateOrgWorker = new Worker(QUEUE_EVALUATE_ORG, async (job: Job) => handleEvaluateOrgJob(job), {
    connection: connectionOptions(),
    concurrency: EVALUATE_ORG_CONCURRENCY,
  });
  attachStandardListeners(evaluateOrgWorker, 'evaluate-org');
  logger.info({ concurrency: EVALUATE_ORG_CONCURRENCY }, 'Alerts evaluate-org worker started');
  return evaluateOrgWorker;
}

export function initAlertsSendWorker(): Worker {
  if (sendWorker) return sendWorker;

  sendWorker = new Worker(QUEUE_SEND, async (job: Job) => handleSendJob(job), {
    connection: connectionOptions(),
    concurrency: SEND_CONCURRENCY,
  });
  attachStandardListeners(sendWorker, 'send');
  logger.info({ concurrency: SEND_CONCURRENCY }, 'Alerts send worker started');
  return sendWorker;
}

export async function shutdownAlertsWorkers(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (orchestratorWorker) {
    logger.info({}, 'Closing alerts orchestrator worker');
    tasks.push(orchestratorWorker.close());
  }
  if (evaluateOrgWorker) {
    logger.info({}, 'Closing alerts evaluate-org worker');
    tasks.push(evaluateOrgWorker.close());
  }
  if (sendWorker) {
    logger.info({}, 'Closing alerts send worker');
    tasks.push(sendWorker.close());
  }
  await Promise.allSettled(tasks);
  orchestratorWorker = null;
  evaluateOrgWorker = null;
  sendWorker = null;
}
