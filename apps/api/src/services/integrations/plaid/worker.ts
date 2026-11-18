import { createIntegrationSyncWorker } from '../syncWorker.js';
import { PlaidConnectionNotFoundError, PlaidItemLoginRequiredError } from './errors.js';
import { runSync } from './sync.js';

export const SYNC_QUEUE_NAME = 'plaid-sync';

const plaidWorker = createIntegrationSyncWorker({
  label: 'Plaid',
  queueName: SYNC_QUEUE_NAME,
  jobPrefix: 'plaid',
  runSync,
  classifyTerminalError(error) {
    // No refresh to attempt: the owner has to run Link again, so retrying burns
    // attempts on a connection that cannot recover on its own.
    if (error instanceof PlaidItemLoginRequiredError) {
      return { reason: 'item login required', message: error.message };
    }
    if (error instanceof PlaidConnectionNotFoundError) {
      return { reason: 'connection not found', message: error.message };
    }
    return null;
  },
});

export const { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker } = plaidWorker;
