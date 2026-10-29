import { getSyncQueue } from './worker.js';
import { createIntegrationSyncScheduler } from '../syncScheduler.js';

const squareScheduler = createIntegrationSyncScheduler({
  provider: 'square',
  label: 'Square',
  jobPrefix: 'square',
  // QuickBooks runs at 3 and Shopify at 4, so stagger Square to 5am UTC.
  dailyCron: '0 5 * * *',
  getSyncQueue,
});

export const { registerDailySync, removeDailySync, initScheduler } = squareScheduler;
