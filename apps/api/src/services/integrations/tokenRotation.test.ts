import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetByIdAndProvider = vi.fn();
const mockUpdateTokensIfUnchanged = vi.fn();
const mockUpdateTokens = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
    updateTokensIfUnchanged: mockUpdateTokensIfUnchanged,
    updateTokens: mockUpdateTokens,
  },
}));
vi.mock('../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { adoptRotatedTokens, commitRotatedTokens } = await import('./tokenRotation.js');

const OLD = 'enc-refresh-old';
const MINE = {
  encryptedAccessToken: 'enc-access-mine',
  encryptedRefreshToken: 'enc-refresh-mine',
  accessTokenExpiresAt: new Date('2026-11-17T10:00:00Z'),
};
const THEIRS = {
  encryptedAccessToken: 'enc-access-theirs',
  encryptedRefreshToken: 'enc-refresh-theirs',
  accessTokenExpiresAt: new Date('2026-11-17T11:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateTokensIfUnchanged.mockResolvedValue(true);
  mockUpdateTokens.mockResolvedValue(undefined);
});

describe('adoptRotatedTokens', () => {
  // Xero's shape: the second refresh is rejected by the provider because the
  // first already invalidated the token. At the HTTP layer that is identical to
  // a real revocation, and treating it as one makes the owner reconnect a
  // healthy connection for nothing.
  it('reports the winner tokens when the stored refresh token has moved', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce({ ...THEIRS });

    const adopted = await adoptRotatedTokens(7, 'xero', OLD);

    expect(adopted).toEqual(THEIRS);
  });

  // The distinction the whole thing turns on. An unchanged token means nobody
  // rotated, so the provider's rejection was real and the caller must surface it.
  it('reports nothing when the stored refresh token is still the one we started from', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce({
      ...THEIRS,
      encryptedRefreshToken: OLD,
    });

    expect(await adoptRotatedTokens(7, 'xero', OLD)).toBeNull();
  });

  it('reports nothing when the connection is gone', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(undefined);

    expect(await adoptRotatedTokens(7, 'xero', OLD)).toBeNull();
  });
});

describe('commitRotatedTokens', () => {
  it('keeps its own pair when the compare-and-set wins', async () => {
    const live = await commitRotatedTokens(7, 'quickbooks', OLD, MINE);

    expect(live).toEqual(MINE);
    expect(mockUpdateTokensIfUnchanged).toHaveBeenCalledWith(
      7,
      OLD,
      MINE.encryptedAccessToken,
      MINE.encryptedRefreshToken,
      MINE.accessTokenExpiresAt,
      expect.anything(),
    );
    expect(mockUpdateTokens).not.toHaveBeenCalled();
  });

  // Intuit's shape: its previous refresh token keeps working for a grace period,
  // so both calls can succeed. The second writer must not overwrite the first,
  // or a token the other sync is already using is replaced mid-flight.
  it('adopts the winner pair and writes nothing when the compare-and-set loses', async () => {
    mockUpdateTokensIfUnchanged.mockResolvedValueOnce(false);
    mockGetByIdAndProvider.mockResolvedValueOnce({ ...THEIRS });

    const live = await commitRotatedTokens(7, 'quickbooks', OLD, MINE);

    expect(live).toEqual(THEIRS);
    expect(mockUpdateTokens).not.toHaveBeenCalled();
  });

  // Should not be reachable: the only thing that moves the stored token is a
  // rotation, and a rotation is what would make the compare fail. Discarding
  // the pair we hold is worse than an unexplained write, because the provider
  // has issued it and will not issue it again.
  it('stores its own pair anyway when the compare lost but nothing visibly rotated', async () => {
    mockUpdateTokensIfUnchanged.mockResolvedValueOnce(false);
    mockGetByIdAndProvider.mockResolvedValueOnce({
      ...THEIRS,
      encryptedRefreshToken: OLD,
    });

    const live = await commitRotatedTokens(7, 'quickbooks', OLD, MINE);

    expect(live).toEqual(MINE);
    expect(mockUpdateTokens).toHaveBeenCalledWith(
      7,
      MINE.encryptedAccessToken,
      MINE.encryptedRefreshToken,
      MINE.accessTokenExpiresAt,
      expect.anything(),
    );
  });
});
