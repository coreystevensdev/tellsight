import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAllOrgs = vi.fn();
const mockGetAllUsers = vi.fn();
const mockGetAdminStats = vi.fn();
const mockGetOrgDetail = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  adminQueries: {
    getAllOrgs: mockGetAllOrgs,
    getAllUsers: mockGetAllUsers,
    getAdminStats: mockGetAdminStats,
    getOrgDetail: mockGetOrgDetail,
  },
}));

vi.mock('../../lib/appError.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/appError.js')>('../../lib/appError.js');
  return actual;
});

const { getOrgsWithStats, getUsers, getOrgDetail } = await import('./adminService.js');

beforeEach(() => vi.clearAllMocks());

describe('adminService', () => {
  describe('getOrgsWithStats', () => {
    it('fetches orgs and stats in parallel', async () => {
      const fakeOrgs = [{ id: 1, name: 'Acme' }];
      const fakeStats = { totalOrgs: 1, totalUsers: 1, proSubscribers: 0 };

      mockGetAllOrgs.mockResolvedValueOnce(fakeOrgs);
      mockGetAdminStats.mockResolvedValueOnce(fakeStats);

      const result = await getOrgsWithStats();

      expect(result).toEqual({ orgs: fakeOrgs, stats: fakeStats });
      expect(mockGetAllOrgs).toHaveBeenCalledOnce();
      expect(mockGetAdminStats).toHaveBeenCalledOnce();
      expect(mockGetAllUsers).not.toHaveBeenCalled();
    });
  });

  describe('getUsers', () => {
    it('returns all users with memberships', async () => {
      const fakeUsers = [{ id: 1, name: 'Alice', orgs: [] }];
      mockGetAllUsers.mockResolvedValueOnce(fakeUsers);

      const result = await getUsers();

      expect(result).toEqual(fakeUsers);
      expect(mockGetAllUsers).toHaveBeenCalledOnce();
      expect(mockGetAllOrgs).not.toHaveBeenCalled();
    });
  });

  describe('getOrgDetail', () => {
    it('returns org detail when found', async () => {
      const fakeOrg = { id: 1, name: 'Acme', members: [], datasets: [], subscription: null };
      mockGetOrgDetail.mockResolvedValueOnce(fakeOrg);

      const result = await getOrgDetail(1);

      expect(result).toEqual(fakeOrg);
      expect(mockGetOrgDetail).toHaveBeenCalledWith(1);
    });

    it('throws NotFoundError when org does not exist', async () => {
      mockGetOrgDetail.mockResolvedValueOnce(null);

      await expect(getOrgDetail(999)).rejects.toThrow('Org 999 not found');
    });
  });
});
