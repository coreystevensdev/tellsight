import { createIntegrationSyncWorker } from '../syncWorker.js';
import { XeroConnectionNotFoundError, XeroNoTenantError, XeroTokenRevokedError } from './errors.js';
import { runSync } from './sync.js';

export const SYNC_QUEUE_NAME = 'xero-sync';

const xeroWorker = createIntegrationSyncWorker({
  label: 'Xero',
  queueName: SYNC_QUEUE_NAME,
  jobPrefix: 'xero',
  runSync,
  classifyTerminalError(error) {
    if (error instanceof XeroTokenRevokedError) {
      return { reason: 'token revoked', message: `Token revoked: ${error.message}` };
    }
    // Consent landed on a practice account rather than an organisation, so
    // there is no ledger to read. Retrying cannot change which tenant the owner
    // picked.
    if (error instanceof XeroNoTenantError) {
      return { reason: 'no organisation tenant', message: error.message };
    }
    if (error instanceof XeroConnectionNotFoundError) {
      return { reason: 'connection not found', message: error.message };
    }
    return null;
  },
});

export const { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker } = xeroWorker;
