import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { checkDatabaseHealth, dbAdmin } from '../lib/db.js';

// The readiness query has to run as the restricted app_user, and its column
// aliases have to match the keys the TypeScript reads back. A mocked client
// proves neither, and getting either wrong would make every deploy roll back.

describe('checkDatabaseHealth against real Postgres', () => {
  it('reports ok on a migrated database', async () => {
    const health = await checkDatabaseHealth();

    // Fails if app_user lacks permission, if an alias is misspelled, or if a
    // required table was renamed out from under the list.
    expect(health).toMatchObject({ status: 'ok' });
    expect(health.reason).toBeUndefined();
    expect(health.missing).toBeUndefined();
  });

  it('names the table that went missing', async () => {
    await dbAdmin.execute(sql`ALTER TABLE data_rows RENAME TO data_rows_healthcheck_probe`);
    try {
      const health = await checkDatabaseHealth();

      expect(health.status).toBe('error');
      expect(health.reason).toBe('schema');
      expect(health.missing).toEqual(['data_rows']);
    } finally {
      await dbAdmin.execute(sql`ALTER TABLE data_rows_healthcheck_probe RENAME TO data_rows`);
    }
  });

  it('recovers once the table is back', async () => {
    const health = await checkDatabaseHealth();
    expect(health.status).toBe('ok');
  });
});
