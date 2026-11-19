import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetByOrgAndProvider = vi.fn();
const mockQuickBooks = vi.fn();
const mockShopify = vi.fn();
const mockSquare = vi.fn();
const mockPlaid = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  integrationConnectionsQueries: { getByOrgAndProvider: mockGetByOrgAndProvider },
}));
vi.mock('../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./worker.js', () => ({ enqueueSyncJob: mockQuickBooks }));
vi.mock('./shopify/worker.js', () => ({ enqueueSyncJob: mockShopify }));
vi.mock('./square/worker.js', () => ({ enqueueSyncJob: mockSquare }));
vi.mock('./plaid/worker.js', () => ({ enqueueSyncJob: mockPlaid }));

const { enqueueBackfill, isResyncProvider, RESYNC_PROVIDERS } = await import('./resync.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByOrgAndProvider.mockResolvedValue({ id: 5, orgId: 2 });
});

describe('enqueueBackfill', () => {
  // The whole point: every provider has to send 'backfill' and not 'manual',
  // because a manual sync asks the provider for what changed and a settled
  // ledger changes nothing (DW-292).
  it.each([
    ['quickbooks', () => mockQuickBooks],
    ['shopify', () => mockShopify],
    ['square', () => mockSquare],
    ['plaid', () => mockPlaid],
  ] as const)('sends %s the backfill trigger', async (provider, getMock) => {
    await enqueueBackfill(2, provider);

    expect(getMock()).toHaveBeenCalledWith(5, 'backfill');
  });

  it('routes each provider to its own queue and no other', async () => {
    await enqueueBackfill(2, 'plaid');

    expect(mockPlaid).toHaveBeenCalledTimes(1);
    for (const other of [mockQuickBooks, mockShopify, mockSquare]) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it('looks the connection up by org and provider', async () => {
    await enqueueBackfill(7, 'square');

    expect(mockGetByOrgAndProvider).toHaveBeenCalledWith(7, 'square', expect.anything());
  });

  // A wrong request, not a failure: asking to resync something an org never
  // connected should be a 404 rather than an error the caller has to catch.
  it('reports nothing when the org has no such connection', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(undefined);

    expect(await enqueueBackfill(2, 'quickbooks')).toBeNull();
    expect(mockQuickBooks).not.toHaveBeenCalled();
  });

  it('returns the connection it queued, so the caller can log which one', async () => {
    expect(await enqueueBackfill(2, 'quickbooks')).toEqual({ connectionId: 5 });
  });
});

describe('isResyncProvider', () => {
  it.each([...RESYNC_PROVIDERS])('accepts %s', (p) => {
    expect(isResyncProvider(p)).toBe(true);
  });

  // csv is a real source type and has no connector to resync, so the guard must
  // not accept everything in sourceTypeSchema.
  it.each(['csv', 'xero', 'stripe', '', 'PLAID', 'quickbooks '])('rejects %o', (p) => {
    expect(isResyncProvider(p)).toBe(false);
  });

  it('covers every connector that has a worker', () => {
    expect([...RESYNC_PROVIDERS].sort()).toEqual(['plaid', 'quickbooks', 'shopify', 'square']);
  });
});
