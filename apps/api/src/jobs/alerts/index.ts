// Public surface for the alerts pipeline. Boot wiring (apps/api/src/index.ts)
// imports init/shutdown from here. Handler and queue internals stay private.

export { initAlertsCronJob, shutdownAlertsCron } from './cron.js';
export {
  initAlertsOrchestratorWorker,
  initAlertsEvaluateOrgWorker,
  initAlertsSendWorker,
  shutdownAlertsWorkers,
} from './workers.js';
export { closeQueues as closeAlertsQueues, enqueueOnUploadCheck as enqueueAlertsOnUploadCheck } from './queue.js';
