import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAllOrgsWithActiveDataset = vi.fn();
const mockGetActiveTier = vi.fn();
const mockGetOrgMembers = vi.fn();
const mockRunCurationPipeline = vi.fn();
const mockAssemblePrompt = vi.fn();
const mockGenerateInterpretation = vi.fn();
const mockSendDigestEmail = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../../config.js', () => ({
  env: { APP_URL: 'https://app.tellsight.com' },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../db/queries/index.js', () => ({
  orgsQueries: { getAllOrgsWithActiveDataset: mockGetAllOrgsWithActiveDataset },
  subscriptionsQueries: { getActiveTier: mockGetActiveTier },
  userOrgsQueries: { getOrgMembers: mockGetOrgMembers },
}));

vi.mock('../curation/index.js', () => ({
  runCurationPipeline: mockRunCurationPipeline,
  assemblePrompt: mockAssemblePrompt,
}));

vi.mock('../aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: mockGenerateInterpretation,
}));

vi.mock('./resendClient.js', () => ({
  sendDigestEmail: mockSendDigestEmail,
}));

vi.mock('../analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

// templates can run un-mocked — they're pure HTML string builders
vi.mock('./templates.js', () => ({
  renderProDigest: vi.fn(() => '<html>pro</html>'),
  renderFreeTeaser: vi.fn(() => '<html>teaser</html>'),
}));

const { processAllDigests, generateDigestForOrg } = await import('./digestService.js');

beforeEach(() => vi.clearAllMocks());

function makeMember(id: number, email: string, digestOptIn = true) {
  return { userId: id, digestOptIn, user: { id, email, name: `User ${id}` } };
}

function makeOrg(id: number, name: string, activeDatasetId = 1) {
  return { id, name, slug: name.toLowerCase(), activeDatasetId, businessProfile: null };
}

describe('generateDigestForOrg', () => {
  it('returns fallback message when curation pipeline yields no insights', async () => {
    mockRunCurationPipeline.mockResolvedValueOnce([]);

    const result = await generateDigestForOrg(1, 10);

    expect(result).toContain('Not enough data');
    expect(mockGenerateInterpretation).not.toHaveBeenCalled();
  });

  it('generates AI interpretation when insights exist', async () => {
    mockRunCurationPipeline.mockResolvedValueOnce([{ stat: 'revenue_up' }]);
    mockAssemblePrompt.mockReturnValueOnce({ prompt: 'analyze this' });
    mockGenerateInterpretation.mockResolvedValueOnce('- Revenue grew 12%');

    const result = await generateDigestForOrg(1, 10);

    expect(result).toBe('- Revenue grew 12%');
    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      [{ stat: 'revenue_up' }],
      'v1-digest',
      undefined,
    );
  });
});

describe('processAllDigests', () => {
  it('sends pro digest with AI summary to opted-in members', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([makeOrg(1, 'Acme')]);
    mockGetActiveTier.mockResolvedValueOnce('pro');
    mockGetOrgMembers.mockResolvedValueOnce([
      makeMember(10, 'alice@acme.com'),
      makeMember(11, 'bob@acme.com'),
    ]);
    mockRunCurationPipeline.mockResolvedValueOnce([{ stat: 'x' }]);
    mockAssemblePrompt.mockReturnValueOnce({ prompt: 'p' });
    mockGenerateInterpretation.mockResolvedValueOnce('- Insight here');
    mockSendDigestEmail.mockResolvedValue(true);

    const results = await processAllDigests();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ orgId: 1, tier: 'pro', emailsSent: 2, emailsFailed: 0 });
    expect(mockSendDigestEmail).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });

  it('sends free teaser to free-tier members', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([makeOrg(2, 'FreeOrg')]);
    mockGetActiveTier.mockResolvedValueOnce('free');
    mockGetOrgMembers.mockResolvedValueOnce([makeMember(20, 'user@free.com')]);
    mockSendDigestEmail.mockResolvedValue(true);

    const results = await processAllDigests();

    expect(results[0]).toMatchObject({ tier: 'free', emailsSent: 1 });
    // free tier should NOT call the curation pipeline or AI
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      2, 20, 'digest.teaser_sent', { tier: 'free' },
    );
  });

  it('skips members who opted out of digest', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([makeOrg(3, 'MixedOrg')]);
    mockGetActiveTier.mockResolvedValueOnce('free');
    mockGetOrgMembers.mockResolvedValueOnce([
      makeMember(30, 'opted-in@mix.com', true),
      makeMember(31, 'opted-out@mix.com', false),
      makeMember(32, 'also-out@mix.com', false),
    ]);
    mockSendDigestEmail.mockResolvedValue(true);

    const results = await processAllDigests();

    expect(results[0]).toMatchObject({ emailsSent: 1 });
    expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mockSendDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'opted-in@mix.com' }),
    );
  });

  it('skips org entirely when all members opted out', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([makeOrg(4, 'AllOut')]);
    mockGetActiveTier.mockResolvedValueOnce('pro');
    mockGetOrgMembers.mockResolvedValueOnce([
      makeMember(40, 'nope@allout.com', false),
    ]);

    const results = await processAllDigests();

    // org gets skipped via `continue`, no result entry
    expect(results).toHaveLength(0);
    expect(mockSendDigestEmail).not.toHaveBeenCalled();
    expect(mockRunCurationPipeline).not.toHaveBeenCalled();
  });

  it('tracks failed emails separately', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([makeOrg(5, 'Flaky')]);
    mockGetActiveTier.mockResolvedValueOnce('pro');
    mockGetOrgMembers.mockResolvedValueOnce([
      makeMember(50, 'ok@flaky.com'),
      makeMember(51, 'fail@flaky.com'),
    ]);
    mockRunCurationPipeline.mockResolvedValueOnce([{ stat: 'x' }]);
    mockAssemblePrompt.mockReturnValueOnce({ prompt: 'p' });
    mockGenerateInterpretation.mockResolvedValueOnce('- Data');
    mockSendDigestEmail
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const results = await processAllDigests();

    expect(results[0]).toMatchObject({ emailsSent: 1, emailsFailed: 1 });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      5, 51, 'digest.failed', { tier: 'pro' },
    );
  });

  it('continues processing remaining orgs when one throws', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([
      makeOrg(6, 'BrokenOrg'),
      makeOrg(7, 'GoodOrg'),
    ]);

    // First org throws during tier check
    mockGetActiveTier
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce('free');

    // Second org succeeds
    mockGetOrgMembers.mockResolvedValueOnce([makeMember(70, 'user@good.com')]);
    mockSendDigestEmail.mockResolvedValue(true);

    const results = await processAllDigests();

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ orgId: 6, emailsSent: 0, emailsFailed: 0 });
    expect(results[1]).toMatchObject({ orgId: 7, emailsSent: 1 });
  });

  it('returns empty array when no orgs have active datasets', async () => {
    mockGetAllOrgsWithActiveDataset.mockResolvedValueOnce([]);

    const results = await processAllDigests();

    expect(results).toEqual([]);
  });
});
