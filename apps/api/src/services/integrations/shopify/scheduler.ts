import { getSyncQueue } from './worker.js';
import { createIntegrationSyncScheduler } from '../syncScheduler.js';

const shopifyScheduler = createIntegrationSyncScheduler({
  provider: 'shopify',
  label: 'Shopify',
  jobPrefix: 'shopify',
  // One hour after QuickBooks to avoid both providers hammering Redis together.
  dailyCron: '0 4 * * *',
  getSyncQueue,
});

export const { registerDailySync, removeDailySync, initScheduler } = shopifyScheduler;
