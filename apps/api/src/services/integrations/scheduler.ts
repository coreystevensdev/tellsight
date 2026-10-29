import { getSyncQueue } from './worker.js';
import { createIntegrationSyncScheduler } from './syncScheduler.js';

const quickBooksScheduler = createIntegrationSyncScheduler({
  provider: 'quickbooks',
  label: 'QB',
  jobPrefix: 'qb',
  dailyCron: '0 3 * * *',
  getSyncQueue,
});

export const { registerDailySync, removeDailySync, initScheduler } = quickBooksScheduler;
