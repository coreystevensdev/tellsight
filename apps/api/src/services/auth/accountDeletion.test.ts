import { describe, it, expect, beforeEach, vi } from 'vitest';

const getUserOrgs = vi.fn();
const getOrgMembers = vi.fn();
const getSubscriptionByOrgId = vi.fn();
const cancel = vi.fn();
const deleteWhere = vi.fn();
const txDelete = vi.fn(() => ({ where: deleteWhere }));

vi.mock('../../db/queries/userOrgs.js', () => ({ getUserOrgs, getOrgMembers }));
vi.mock('../../db/queries/subscriptions.js', () => ({ getSubscriptionByOrgId }));
vi.mock('../subscription/stripeService.js', () => ({
  getStripe: () => ({ subscriptions: { cancel } }),
}));
vi.mock('../../lib/db.js', () => ({
  dbAdmin: { transaction: vi.fn((fn: (t: unknown) => unknown) => fn({ delete: txDelete })) },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { deleteAccount } = await import('./accountDeletion.js');

const membership = (orgId: number, role: 'owner' | 'member', name = `Org ${orgId}`) =>
  ({ orgId, userId: 1, role, org: { id: orgId, name } });

beforeEach(() => {
  vi.clearAllMocks();
  getSubscriptionByOrgId.mockResolvedValue(null);
});

describe('deleteAccount', () => {
  it('deletes an org the user was the last member of', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner')]);
    getOrgMembers.mockResolvedValue([membership(7, 'owner')]);

    const result = await deleteAccount(1);

    expect(result.deletedOrgIds).toEqual([7]);
    // the org, then the user
    expect(txDelete).toHaveBeenCalledTimes(2);
  });

  it('leaves an org standing when someone else owns it too', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner')]);
    getOrgMembers.mockResolvedValue([
      membership(7, 'owner'),
      { orgId: 7, userId: 2, role: 'owner', org: { id: 7, name: 'Org 7' } },
    ]);

    const result = await deleteAccount(1);

    expect(result).toEqual({ deletedOrgIds: [], leftOrgIds: [7] });
    expect(txDelete).toHaveBeenCalledTimes(1); // the user only
  });

  it('leaves an org standing when the user was only a member', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'member')]);
    getOrgMembers.mockResolvedValue([
      membership(7, 'member'),
      { orgId: 7, userId: 2, role: 'owner', org: { id: 7, name: 'Org 7' } },
    ]);

    expect((await deleteAccount(1)).leftOrgIds).toEqual([7]);
  });

  // Removing the last owner would leave members holding an org nobody can bill,
  // invite to, or delete.
  it('refuses when it would strand members with no owner', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner', 'Sunrise Cafe')]);
    getOrgMembers.mockResolvedValue([
      membership(7, 'owner'),
      { orgId: 7, userId: 2, role: 'member', org: { id: 7, name: 'Sunrise Cafe' } },
    ]);

    await expect(deleteAccount(1)).rejects.toThrow(/transfer ownership/i);
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('cancels the subscription of an org it is about to delete', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner')]);
    getOrgMembers.mockResolvedValue([membership(7, 'owner')]);
    getSubscriptionByOrgId.mockResolvedValue({ stripeSubscriptionId: 'sub_x', status: 'active' });

    await deleteAccount(1);

    expect(cancel).toHaveBeenCalledWith('sub_x');
  });

  it('does not re-cancel one Stripe already cancelled', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner')]);
    getOrgMembers.mockResolvedValue([membership(7, 'owner')]);
    getSubscriptionByOrgId.mockResolvedValue({ stripeSubscriptionId: 'sub_x', status: 'canceled' });

    await deleteAccount(1);

    expect(cancel).not.toHaveBeenCalled();
  });

  // Deleting the row first would leave a live subscription billing a deleted
  // account, with nothing left in the system naming which one to go and cancel.
  it('deletes nothing when Stripe refuses the cancellation', async () => {
    getUserOrgs.mockResolvedValue([membership(7, 'owner')]);
    getOrgMembers.mockResolvedValue([membership(7, 'owner')]);
    getSubscriptionByOrgId.mockResolvedValue({ stripeSubscriptionId: 'sub_x', status: 'active' });
    cancel.mockRejectedValueOnce(new Error('Stripe is down'));

    await expect(deleteAccount(1)).rejects.toThrow('Stripe is down');
    expect(txDelete).not.toHaveBeenCalled();
  });
});
