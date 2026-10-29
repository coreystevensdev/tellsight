import { runSync } from './sync.js';
import { ScopeDeniedError, TokenRevokedError, ConnectionNotFoundError } from './errors.js';
import { createIntegrationSyncWorker } from '../syncWorker.js';

export const SYNC_QUEUE_NAME = 'shopify-sync';

const shopifyWorker = createIntegrationSyncWorker({
  label: 'Shopify',
  queueName: SYNC_QUEUE_NAME,
  jobPrefix: 'shopify',
  runSync,
  classifyTerminalError(error) {
    if (error instanceof TokenRevokedError) {
      return { reason: 'token revoked', message: `Token revoked: ${error.message}` };
    }
    if (error instanceof ScopeDeniedError) {
      return { reason: 'scope missing', message: error.message };
    }
    if (error instanceof ConnectionNotFoundError) {
      return { reason: 'connection not found', message: error.message };
    }
    return null;
  },
});

export const { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker } = shopifyWorker;
