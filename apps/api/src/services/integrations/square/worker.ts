import { runSync } from './sync.js';
import { TokenRevokedError, ConnectionNotFoundError } from './errors.js';
import { createIntegrationSyncWorker } from '../syncWorker.js';

export const SYNC_QUEUE_NAME = 'square-sync';

const squareWorker = createIntegrationSyncWorker({
  label: 'Square',
  queueName: SYNC_QUEUE_NAME,
  jobPrefix: 'square',
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

export const { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker } = squareWorker;
