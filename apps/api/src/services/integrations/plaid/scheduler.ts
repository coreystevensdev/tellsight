import { createIntegrationSyncScheduler } from '../syncScheduler.js';
import { getSyncQueue } from './worker.js';

// 6am UTC, the next free slot after QuickBooks at 3, Shopify at 4 and Square at
// 5. Spaced an hour apart so one org with several connectors does not run every
// sync at once on a t2.micro.
//
// Later in the day than the others would read better for a US owner, but the
// cron is UTC and the digest pipeline owns the morning. A bank feed is also the
// least time-sensitive of the four: transactions settle overnight, so the only
// thing a later slot buys is a shorter wait for data that is already a day old.
const plaidScheduler = createIntegrationSyncScheduler({
  provider: 'plaid',
  label: 'Plaid',
  jobPrefix: 'plaid',
  dailyCron: '0 6 * * *',
  getSyncQueue,
});

export const { registerDailySync, removeDailySync, initScheduler } = plaidScheduler;
