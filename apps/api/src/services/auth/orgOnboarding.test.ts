import { describe, it, expect, beforeEach, vi } from 'vitest';

const createOrg = vi.fn();
const findOrgBySlug = vi.fn();
const addMember = vi.fn();
const createDataset = vi.fn();
const insertBatch = vi.fn();
const loggerError = vi.fn();
const tx = { marker: 'tx' };

vi.mock('../../db/queries/orgs.js', () => ({ createOrg, findOrgBySlug }));
vi.mock('../../db/queries/userOrgs.js', () => ({ addMember }));
vi.mock('../../db/queries/datasets.js', () => ({ createDataset }));
vi.mock('../../db/queries/dataRows.js', () => ({ insertBatch }));
vi.mock('../../lib/db.js', () => ({
  dbAdmin: { transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { error: loggerError, info: vi.fn(), warn: vi.fn() } }));

const { createOwnerOrgForUser } = await import('./orgOnboarding.js');

beforeEach(() => {
  vi.clearAllMocks();
  findOrgBySlug.mockResolvedValue(undefined);
  createOrg.mockResolvedValue({ id: 77, name: "Dana's Organization", slug: 'dana-org' });
  addMember.mockResolvedValue({ orgId: 77, userId: 5, role: 'owner' });
  createDataset.mockResolvedValue({ id: 900 });
});

describe('createOwnerOrgForUser', () => {
  it('makes the new user the owner of their own org', async () => {
    const { org, membership } = await createOwnerOrgForUser(5, 'Dana');

    expect(createOrg).toHaveBeenCalledWith({ name: "Dana's Organization", slug: 'dana-org' });
    expect(addMember).toHaveBeenCalledWith(77, 5, 'owner', expect.anything());
    expect(org.id).toBe(77);
    expect(membership.role).toBe('owner');
  });

  it('suffixes the slug when one is already taken', async () => {
    findOrgBySlug.mockResolvedValueOnce({ id: 1 }).mockResolvedValue(undefined);

    await createOwnerOrgForUser(5, 'Dana');

    expect(createOrg.mock.calls[0]?.[0].slug).toMatch(/^dana-org-[0-9a-f]{4}$/);
  });

  it('seeds the org with demo data so the first dashboard is not empty', async () => {
    await createOwnerOrgForUser(5, 'Dana');

    expect(createDataset).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ isSeedData: true }),
      tx,
    );

    const [orgId, datasetId, rows, client] = insertBatch.mock.calls[0] ?? [];
    expect(orgId).toBe(77);
    expect(datasetId).toBe(900);
    expect(rows.length).toBeGreaterThan(0);
    expect(client).toBe(tx);
  });

  // The dataset and its rows go in one transaction; a dataset with no rows would
  // leave the dashboard pointed at a chart with nothing in it.
  it('writes the dataset and the rows through the same transaction', async () => {
    await createOwnerOrgForUser(5, 'Dana');

    expect(createDataset.mock.calls[0]?.[2]).toBe(insertBatch.mock.calls[0]?.[3]);
  });

  it('still returns the org when seeding fails, and says so', async () => {
    insertBatch.mockRejectedValueOnce(new Error('deadlock detected'));

    const { org } = await createOwnerOrgForUser(5, 'Dana');

    expect(org.id).toBe(77);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 77 }),
      expect.stringContaining('seed'),
    );
  });
});
