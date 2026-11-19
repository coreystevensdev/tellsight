import { createIntegrationSyncScheduler } from '../syncScheduler.js';
import { getSyncQueue } from './worker.js';

// 7am UTC, the next free slot after QuickBooks at 3, Shopify at 4, Square at 5
// and Plaid at 6. Spaced an hour apart so one org with several connectors does
// not run every sync at once on a t3.micro.
const xeroScheduler = createIntegrationSyncScheduler({
  provider: 'xero',
  label: 'Xero',
  jobPrefix: 'xero',
  dailyCron: '0 7 * * *',
  getSyncQueue,
});

export const { registerDailySync, removeDailySync, initScheduler } = xeroScheduler;
