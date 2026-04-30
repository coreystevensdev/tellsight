import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const mockGetCachedSummary = vi.fn();
const mockFindOrgById = vi.fn();
const mockCreateShare = vi.fn();
const mockFindByTokenHash = vi.fn();
const mockIncrementViewCount = vi.fn();

vi.mock('../../db/queries/aiSummaries.js', () => ({
  getCachedSummary: mockGetCachedSummary,
}));

vi.mock('../../db/queries/orgs.js', () => ({
  findOrgById: mockFindOrgById,
}));

vi.mock('../../db/queries/shares.js', () => ({
  createShare: mockCreateShare,
  findByTokenHash: mockFindByTokenHash,
  incrementViewCount: mockIncrementViewCount,
}));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  env: { APP_URL: 'http://localhost:3000' },
}));

const { generateShareLink, getSharedInsight } = await import('./shareService.js');

describe('shareService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateShareLink', () => {
    const fakeSummary = {
      id: 1,
      content: 'Revenue grew 12% MoM driven by catering orders.',
      transparencyMetadata: { dateRange: 'Jan 2026, Feb 2026' },
    };
    const fakeOrg = { id: 10, name: 'Sunrise Cafe', slug: 'sunrise-cafe' };

    it('returns a share URL with a raw token and expiry', async () => {
      mockGetCachedSummary.mockResolvedValueOnce(fakeSummary);
      mockFindOrgById.mockResolvedValueOnce(fakeOrg);
      mockCreateShare.mockImplementationOnce(
        (_orgId, _dsId, _hash, _snapshot, _createdBy, expiresAt) => ({
          id: 1,
          expiresAt,
        }),
      );

      const result = await generateShareLink(10, 5, 1);

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.url).toBe(`http://localhost:3000/share/${result.token}`);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('stores a SHA-256 hash, not the raw token', async () => {
      mockGetCachedSummary.mockResolvedValueOnce(fakeSummary);
      mockFindOrgById.mockResolvedValueOnce(fakeOrg);
      mockCreateShare.mockImplementationOnce(
        (_orgId, _dsId, _hash, _snapshot, _createdBy, expiresAt) => ({
          id: 2,
          expiresAt,
        }),
      );

      const result = await generateShareLink(10, 5, 1);
      const storedHash = mockCreateShare.mock.calls[0]![2];

      expect(storedHash).not.toBe(result.token);
      const expectedHash = createHash('sha256').update(result.token).digest('hex');
      expect(storedHash).toBe(expectedHash);
    });

    it('snapshots orgName and aiSummaryContent into the share', async () => {
      mockGetCachedSummary.mockResolvedValueOnce(fakeSummary);
      mockFindOrgById.mockResolvedValueOnce(fakeOrg);
      mockCreateShare.mockImplementationOnce(
        (_orgId, _dsId, _hash, _snap, _createdBy, expiresAt) => ({
          id: 3,
          expiresAt,
        }),
      );

      await generateShareLink(10, 5, 1);

      const snapshot = mockCreateShare.mock.calls[0]![3];
      expect(snapshot.orgName).toBe('Sunrise Cafe');
      expect(snapshot.aiSummaryContent).toBe(fakeSummary.content);
      expect(snapshot.dateRange).toBe('Jan 2026, Feb 2026');
    });

    it('falls back to placeholder when transparencyMetadata lacks dateRange', async () => {
      const noDateSummary = { id: 1, content: 'Some insight.', transparencyMetadata: {} };
      mockGetCachedSummary.mockResolvedValueOnce(noDateSummary);
      mockFindOrgById.mockResolvedValueOnce(fakeOrg);
      mockCreateShare.mockImplementationOnce(
        (_orgId, _dsId, _hash, _snap, _createdBy, expiresAt) => ({
          id: 4,
          expiresAt,
        }),
      );

      await generateShareLink(10, 5, 1);

      const snapshot = mockCreateShare.mock.calls[0]![3];
      expect(snapshot.dateRange).toBe('Date range unavailable');
    });

    it('throws ValidationError when no cached summary exists', async () => {
      mockGetCachedSummary.mockResolvedValueOnce(null);

      await expect(generateShareLink(10, 5, 1)).rejects.toThrow(
        'no cached summary',
      );
    });

    it('throws NotFoundError when org is missing', async () => {
      mockGetCachedSummary.mockResolvedValueOnce(fakeSummary);
      mockFindOrgById.mockResolvedValueOnce(null);

      await expect(generateShareLink(10, 5, 1)).rejects.toThrow(
        'Organization not found',
      );
    });
  });

  describe('getSharedInsight', () => {
    const fakeSnapshot = {
      orgName: 'Sunrise Cafe',
      dateRange: 'Jan 2026, Feb 2026',
      aiSummaryContent: 'Revenue grew 12% MoM.',
      chartConfig: { type: 'bar' },
    };

    it('returns snapshot data and increments view count', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        insightSnapshot: fakeSnapshot,
        expiresAt: new Date(Date.now() + 86_400_000),
        viewCount: 3,
      });
      mockIncrementViewCount.mockResolvedValueOnce(undefined);

      const result = await getSharedInsight('a'.repeat(64));

      expect(result.orgName).toBe('Sunrise Cafe');
      expect(result.aiSummaryContent).toBe('Revenue grew 12% MoM.');
      expect(result.chartConfig).toEqual({ type: 'bar' });
      expect(result.viewCount).toBe(4); // 3 + 1
      expect(mockIncrementViewCount).toHaveBeenCalledWith(1, expect.anything());
    });

    it('throws NotFoundError for an unknown token', async () => {
      mockFindByTokenHash.mockResolvedValueOnce(null);

      await expect(getSharedInsight('bad-token')).rejects.toThrow(
        'Share not found',
      );
    });

    it('throws 410 GONE for an expired share', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 2,
        insightSnapshot: fakeSnapshot,
        expiresAt: new Date(Date.now() - 86_400_000), // yesterday
        viewCount: 5,
      });

      await expect(getSharedInsight('a'.repeat(64))).rejects.toThrow(
        'expired',
      );
      expect(mockIncrementViewCount).not.toHaveBeenCalled();
    });

    it('works when expiresAt is null (no expiry)', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 3,
        insightSnapshot: fakeSnapshot,
        expiresAt: null,
        viewCount: 0,
      });
      mockIncrementViewCount.mockResolvedValueOnce(undefined);

      const result = await getSharedInsight('a'.repeat(64));

      expect(result.viewCount).toBe(1);
    });
  });
});
