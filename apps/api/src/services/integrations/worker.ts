import { runSync } from './quickbooks/sync.js';
import { TokenRevokedError, ConnectionNotFoundError } from './quickbooks/errors.js';
import { createIntegrationSyncWorker } from './syncWorker.js';

export const SYNC_QUEUE_NAME = 'quickbooks-sync';

const quickBooksWorker = createIntegrationSyncWorker({
  label: 'QB',
  queueName: SYNC_QUEUE_NAME,
  jobPrefix: 'qb',
  runSync,
  classifyTerminalError(error) {
    if (error instanceof TokenRevokedError) {
      return { reason: 'token revoked', message: `Token revoked: ${error.message}` };
    }
    if (error instanceof ConnectionNotFoundError) {
      return { reason: 'connection not found', message: error.message };
    }
    return null;
  },
});

export const { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker } = quickBooksWorker;
