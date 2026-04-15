import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertValues = vi.fn();
const mockOnConflict = vi.fn();
const mockReturning = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<unknown[]> };
const mockSelectFrom = vi.fn();
const mockWhere = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<void> | undefined; _directResult: Promise<unknown[]> | undefined };
const mockLimit = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<unknown[]> };
const mockSet = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../lib/db.js', () => ({
  db: {
    select: () => ({
      from: (...args: unknown[]) => {
        mockSelectFrom(...args);
        return {
          where: (...w: unknown[]) => {
            mockWhere(...w);
            const whereResult = {
              limit: (n: number) => { mockLimit(n); return mockLimit._result; },
              then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                const p = mockWhere._directResult ?? mockLimit._result ?? Promise.resolve([]);
                return p.then(resolve, reject);
              },
            };
            return whereResult;
          },
        };
      },
    }),
    insert: () => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return {
          onConflictDoUpdate: (...c: unknown[]) => {
            mockOnConflict(...c);
            return { returning: () => { mockReturning(); return mockReturning._result; } };
          },
          returning: () => { mockReturning(); return mockReturning._result; },
        };
      },
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockSet(...args);
        return {
          where: (...w: unknown[]) => { mockWhere(...w); return mockWhere._result ?? Promise.resolve(); },
        };
      },
    }),
    delete: () => ({
      where: (...args: unknown[]) => {
        mockDelete(...args);
        return {
          returning: () => { mockReturning(); return mockReturning._result; },
        };
      },
    }),
  },
}));

vi.mock('../schema.js', () => ({
  integrationConnections: {
    id: 'id',
    orgId: 'org_id',
    provider: 'provider',
    providerTenantId: 'provider_tenant_id',
    encryptedRefreshToken: 'encrypted_refresh_token',
    encryptedAccessToken: 'encrypted_access_token',
    accessTokenExpiresAt: 'access_token_expires_at',
    scope: 'scope',
    lastSyncedAt: 'last_synced_at',
    syncStatus: 'sync_status',
    syncError: 'sync_error',
    updatedAt: 'updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const mockConnection = {
  id: 1,
  orgId: 10,
  provider: 'quickbooks',
  providerTenantId: 'realm123',
  encryptedRefreshToken: 'enc-refresh',
  encryptedAccessToken: 'enc-access',
  accessTokenExpiresAt: new Date('2026-04-15T12:00:00Z'),
  scope: 'com.intuit.quickbooks.accounting',
  lastSyncedAt: null,
  syncStatus: 'idle',
  syncError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('integrationConnections queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getByOrgAndProvider', () => {
    it('returns connection when found', async () => {
      mockLimit._result =
        Promise.resolve([mockConnection]);

      const { getByOrgAndProvider } = await import('./integrationConnections.js');
      const result = await getByOrgAndProvider(10, 'quickbooks');

      expect(result).toEqual(mockConnection);
      expect(mockLimit).toHaveBeenCalledWith(1);
    });

    it('returns null when not found', async () => {
      mockLimit._result =
        Promise.resolve([]);

      const { getByOrgAndProvider } = await import('./integrationConnections.js');
      const result = await getByOrgAndProvider(10, 'quickbooks');

      expect(result).toBeNull();
    });
  });

  describe('upsert', () => {
    it('inserts and returns connection', async () => {
      mockReturning._result =
        Promise.resolve([mockConnection]);

      const { upsert } = await import('./integrationConnections.js');
      const result = await upsert({
        orgId: 10,
        provider: 'quickbooks',
        providerTenantId: 'realm123',
        encryptedRefreshToken: 'enc-refresh',
        encryptedAccessToken: 'enc-access',
        accessTokenExpiresAt: new Date('2026-04-15T12:00:00Z'),
      });

      expect(result).toEqual(mockConnection);
      expect(mockInsertValues).toHaveBeenCalled();
      expect(mockOnConflict).toHaveBeenCalled();
    });
  });

  describe('updateSyncStatus', () => {
    it('sets status and optional error', async () => {
      mockWhere._result =
        Promise.resolve();

      const { updateSyncStatus } = await import('./integrationConnections.js');
      await updateSyncStatus(1, 'error', 'Token revoked');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          syncStatus: 'error',
          syncError: 'Token revoked',
        }),
      );
    });

    it('clears error when not provided', async () => {
      mockWhere._result =
        Promise.resolve();

      const { updateSyncStatus } = await import('./integrationConnections.js');
      await updateSyncStatus(1, 'idle');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          syncStatus: 'idle',
          syncError: null,
        }),
      );
    });
  });

  describe('updateTokens', () => {
    it('replaces encrypted tokens and expiry', async () => {
      mockWhere._result =
        Promise.resolve();

      const expiry = new Date('2026-04-15T13:00:00Z');
      const { updateTokens } = await import('./integrationConnections.js');
      await updateTokens(1, 'new-access', 'new-refresh', expiry);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          encryptedAccessToken: 'new-access',
          encryptedRefreshToken: 'new-refresh',
          accessTokenExpiresAt: expiry,
        }),
      );
    });
  });

  describe('deleteByOrgAndProvider', () => {
    it('deletes and returns count', async () => {
      mockReturning._result =
        Promise.resolve([{ id: 1 }]);

      const { deleteByOrgAndProvider } = await import('./integrationConnections.js');
      const count = await deleteByOrgAndProvider(10, 'quickbooks');

      expect(count).toBe(1);
      expect(mockDelete).toHaveBeenCalled();
    });

    it('returns 0 when nothing deleted', async () => {
      mockReturning._result =
        Promise.resolve([]);

      const { deleteByOrgAndProvider } = await import('./integrationConnections.js');
      const count = await deleteByOrgAndProvider(10, 'quickbooks');

      expect(count).toBe(0);
    });
  });

  describe('getAllByProvider', () => {
    it('returns all connections for provider', async () => {
      const connections = [mockConnection, { ...mockConnection, id: 2, orgId: 20 }];
      mockWhere._directResult =
        Promise.resolve(connections);

      const { getAllByProvider } = await import('./integrationConnections.js');
      const result = await getAllByProvider('quickbooks');

      expect(result).toHaveLength(2);
      mockWhere._directResult = undefined;
    });
  });
});
