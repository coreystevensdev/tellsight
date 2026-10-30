import { describe, expect, it, vi } from 'vitest';

import { checkIntegrationDatabase, type DatabaseProbe } from './integrationDatabasePreflight.js';

const environment = {
  DATABASE_URL: 'postgresql://app_user:app-secret@localhost:5433/analytics',
  DATABASE_ADMIN_URL: 'postgresql://app_admin:admin-secret@localhost:5433/analytics',
};

function healthyProbe(): DatabaseProbe {
  return vi.fn(async (url) => ({
    currentUser: url.includes('app_admin') ? 'app_admin' : 'app_user',
    databaseName: 'analytics',
    schemaPresent: true,
  }));
}

describe('integration database preflight', () => {
  it('requires both database URLs before probing', async () => {
    const probe = healthyProbe();

    await expect(checkIntegrationDatabase({}, probe)).rejects.toThrow('DATABASE_URL is required');
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports an unreachable target without exposing credentials', async () => {
    const probe: DatabaseProbe = vi.fn().mockRejectedValue(new Error('connection refused'));

    const error = await checkIntegrationDatabase(environment, probe).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('localhost:5433/analytics');
    expect((error as Error).message).not.toContain('app-secret');
    expect((error as Error).message).not.toContain('admin-secret');
  });

  it('requires the application schema to be migrated', async () => {
    const probe: DatabaseProbe = vi.fn(async (url) => ({
      currentUser: url.includes('app_admin') ? 'app_admin' : 'app_user',
      databaseName: 'analytics',
      schemaPresent: false,
    }));

    await expect(checkIntegrationDatabase(environment, probe)).rejects.toThrow('schema is missing');
  });

  it('requires separate application and administrator roles', async () => {
    const probe: DatabaseProbe = vi.fn(async () => ({
      currentUser: 'app_admin',
      databaseName: 'analytics',
      schemaPresent: true,
    }));

    await expect(checkIntegrationDatabase(environment, probe)).rejects.toThrow(
      'must use different database roles',
    );
  });

  it('accepts a migrated database with distinct roles', async () => {
    const probe = healthyProbe();

    await expect(checkIntegrationDatabase(environment, probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
