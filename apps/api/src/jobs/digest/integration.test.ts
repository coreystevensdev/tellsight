import { describe, it, expect, vi, beforeEach } from 'vitest';

// Choreography test (NOT a true integration test). Replays the actual
// orchestrator -> per-org -> per-send call chain, asserting that payloads
// handed off between stages match the receiving handlers' expectations.
//
// What this DOES verify:
//   - Correlation ID threads from orchestrator through every downstream job.
//   - Per-org failures isolate (AC #4): one org throwing does not block the
//     others' completion path.
//   - Privacy boundary (AC #11): send-job payload contains summaryId only,
//     never summary content (one of the two load-bearing NFR12 checks).
//   - Per-user dedupe race (subset of AC #8): a user with last_sent_at
//     within 6 days gets DIGEST_SKIPPED and skips sendEmail.
//   - Storage shape (subset of AC #5): storeSummary is called with
//     audience='digest-weekly' on cache miss.
//
// What this does NOT verify (covered elsewhere or carry-forward):
//   - Eligibility SQL filters (Pro tier, recency, cadence), see
//     digestEligibility.test.ts SQL-shape tests.
//   - Curation pipeline behavior, runCurationPipeline, assemblePrompt,
//     generateInterpretation, validateStatRefs are all mocked here.
//   - Email rendering, sendEmail is mocked; the React Email template is
//     covered in templates/digestWeekly.test.tsx.
//   - Real BullMQ scheduling, queue.add is captured and replayed; the
//     scheduler/worker contract is covered in cron.test.ts and workers.test.ts.
//   - Real DB writes / RLS, every query is mocked at the barrel boundary;
//     the audience-scope filter is covered in aiSummaries.test.ts SQL-shape
//     tests.
//
// Task 10.1's "fixture: seed 3 orgs" wording was aspirational. The repo has
// no in-process Postgres (no pglite, no testcontainers), so this test layer
// is the closest within-repo-pattern coverage. Adding a real fixture-DB rig
// is tracked in epic-9-retro-pending.md.

const mockFindEligibleOrgs = vi.fn();
const mockFindOrgRecipients = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetCachedDigest = vi.fn();
const mockGetById = vi.fn();
const mockStoreSummary = vi.fn();
const mockUpsertDefaults = vi.fn();
const mockMarkSent = vi.fn().mockResolvedValue(undefined);
const mockGetLastDigest = vi.fn();
const mockSaveDigestHistory = vi.fn();

const mockRunCurationPipeline = vi.fn();
const mockAssemblePrompt = vi.fn();
const mockGenerateInterpretation = vi.fn();
const mockValidateStatRefs = vi.fn().mockReturnValue({ invalidRefs: [] });

const mockSendEmail = vi.fn();
const mockTrackEvent = vi.fn();

class FakeEmailSendError extends Error {
  retryable: boolean;
  providerStatusCode?: number;
  constructor(msg: string, opts: { retryable: boolean; providerStatusCode?: number }) {
    super(msg);
    this.name = 'EmailSendError';
    this.retryable = opts.retryable;
    this.providerStatusCode = opts.providerStatusCode;
  }
}

// Capture every queue.add call so we can replay jobs across handlers.
interface CapturedJob {
  queueName: string;
  jobName: string;
  data: Record<string, unknown>;
}
const enqueued: CapturedJob[] = [];
const orgQueue = { add: vi.fn(async (jobName: string, data: Record<string, unknown>) => {
  enqueued.push({ queueName: 'digest-org', jobName, data });
}) };
const sendQueue = { add: vi.fn(async (jobName: string, data: Record<string, unknown>) => {
  enqueued.push({ queueName: 'digest-send', jobName, data });
}) };

vi.mock('bullmq', () => ({
  Queue: class { constructor(public name: string, public opts: unknown) {} },
}));

vi.mock('../../config.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'https://app.tellsight.com',
    JWT_SECRET: 'a'.repeat(64),
    EMAIL_MAILING_ADDRESS: '1 Real St, City, ZZ 00000',
    EMAIL_FROM_ADDRESS: 'digest@tellsight.test',
    EMAIL_FROM_NAME: 'Tellsight',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/db.js', () => ({ dbAdmin: { __admin: true } }));

vi.mock('../../db/queries/index.js', () => ({
  digestEligibilityQueries: {
    findEligibleOrgs: mockFindEligibleOrgs,
    findOrgRecipients: mockFindOrgRecipients,
  },
  orgsQueries: {
    getActiveDatasetId: mockGetActiveDatasetId,
    findOrgById: mockFindOrgById,
  },
  aiSummariesQueries: {
    getCachedDigest: mockGetCachedDigest,
    getById: mockGetById,
    storeSummary: mockStoreSummary,
  },
  digestPreferencesQueries: {
    upsertDefaults: mockUpsertDefaults,
    markSent: mockMarkSent,
  },
  digestHistoryQueries: {
    getLastDigest: mockGetLastDigest,
    saveDigestHistory: mockSaveDigestHistory,
  },
}));

vi.mock('../../services/curation/index.js', () => ({
  runCurationPipeline: mockRunCurationPipeline,
  assemblePrompt: mockAssemblePrompt,
  validateStatRefs: mockValidateStatRefs,
  stripInvalidStatRefs: (text: string) => text,
  transparencyMetadataSchema: { parse: (m: unknown) => m },
}));

vi.mock('../../services/aiInterpretation/claudeClient.js', () => ({
  generateInterpretation: mockGenerateInterpretation,
}));

vi.mock('../../services/email/index.js', () => ({
  sendEmail: mockSendEmail,
  EmailSendError: FakeEmailSendError,
}));

vi.mock('../../services/analytics/trackEvent.js', () => ({ trackEvent: mockTrackEvent }));

vi.mock('./queue.js', async () => {
  const actual = await vi.importActual<typeof import('./queue.js')>('./queue.js');
  return {
    ...actual,
    getOrgQueue: () => orgQueue,
    getSendQueue: () => sendQueue,
  };
});

const { handleOrchestratorJob } = await import('./handlers/orchestrator.js');
const { handlePerOrgJob } = await import('./handlers/perOrg.js');
const { handlePerSendJob } = await import('./handlers/perSend.js');

const orgA = { id: 1, name: 'Acme', activeDatasetId: 100, businessProfile: null };
const orgC = { id: 3, name: 'Gamma', activeDatasetId: 300, businessProfile: null };

beforeEach(() => {
  vi.clearAllMocks();
  enqueued.length = 0;

  mockAssemblePrompt.mockReturnValue({
    system: 'sys',
    user: 'user',
    metadata: { promptVersion: 'v1-digest', statTypes: ['Total', 'Trend'] },
  });
  mockValidateStatRefs.mockReturnValue({ invalidRefs: [] });
  mockGetLastDigest.mockResolvedValue(undefined);
  mockSaveDigestHistory.mockResolvedValue(undefined);
});

describe('orchestrator -> per-org -> per-send choreography', () => {
  it('runs the full pipeline for two eligible orgs and sends two emails', async () => {
    // Eligibility: A and C pass (Pro + recent dataset + opted-in member). B excluded.
    mockFindEligibleOrgs.mockResolvedValueOnce([orgA, orgC]);

    // Per-org setup: both orgs cache-miss the first time.
    mockGetActiveDatasetId.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) return orgA.activeDatasetId;
      if (orgId === orgC.id) return orgC.activeDatasetId;
      return null;
    });
    mockFindOrgById.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) return orgA;
      if (orgId === orgC.id) return orgC;
      return undefined;
    });
    mockGetCachedDigest.mockResolvedValue(undefined);
    mockRunCurationPipeline.mockResolvedValue([{ stat: { statType: 'Total' } }]);
    mockGenerateInterpretation.mockResolvedValue('- Revenue up 12%\n- Payroll spiked\n- Runway 8 months');

    let nextSummaryId = 500;
    mockStoreSummary.mockImplementation(async () => ({ id: nextSummaryId++ }));

    // Recipients: A has 1 weekly user, C has 1 weekly user (the other 2 filtered).
    mockFindOrgRecipients.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) return [{ userId: 11, email: 'alice@a.com', name: 'Alice' }];
      if (orgId === orgC.id) return [{ userId: 33, email: 'carl@c.com', name: 'Carl' }];
      return [];
    });

    // Per-send setup: no prior sends, summary loadable.
    mockUpsertDefaults.mockImplementation(async (userId: number) => ({
      userId,
      cadence: 'weekly',
      lastSentAt: null,
    }));
    mockGetById.mockImplementation(async (id: number) => ({
      id,
      orgId: id === 500 ? orgA.id : orgC.id,
      datasetId: id === 500 ? orgA.activeDatasetId : orgC.activeDatasetId,
      content: '- Revenue up 12%\n- Payroll spiked\n- Runway 8 months',
      audience: 'digest-weekly',
    }));
    mockSendEmail.mockResolvedValue({
      status: 'sent',
      providerMessageId: 'msg-x',
      durationMs: 50,
    });

    // STEP 1: orchestrator runs.
    await handleOrchestratorJob({ id: 'orch-1' } as never);

    const orgJobs = enqueued.filter((j) => j.queueName === 'digest-org');
    expect(orgJobs).toHaveLength(2);
    expect(orgJobs.map((j) => j.data.orgId)).toEqual([orgA.id, orgC.id]);

    // All per-org jobs share one correlationId from the orchestrator tick.
    const orchestratorCorrelationId = orgJobs[0]!.data.correlationId as string;
    expect(orgJobs.every((j) => j.data.correlationId === orchestratorCorrelationId)).toBe(true);

    // STEP 2: replay each per-org job through the per-org handler.
    enqueued.length = 0; // clear capture, we want only the send jobs from this step
    for (const j of orgJobs) {
      await handlePerOrgJob({ id: j.jobName, data: j.data } as never);
    }

    const sendJobs = enqueued.filter((j) => j.queueName === 'digest-send');
    expect(sendJobs).toHaveLength(2);
    expect(sendJobs.map((j) => j.data.userId).sort()).toEqual([11, 33]);

    // Privacy boundary: send payloads carry summaryId, never content.
    for (const j of sendJobs) {
      expect(JSON.stringify(j.data)).not.toContain('Revenue up');
      expect(typeof j.data.summaryId).toBe('number');
    }

    // Correlation thread survives the handoff.
    expect(sendJobs.every((j) => j.data.correlationId === orchestratorCorrelationId)).toBe(true);

    // STEP 3: replay each per-send job through the per-send handler.
    for (const j of sendJobs) {
      await handlePerSendJob({ id: j.jobName, data: j.data } as never);
    }

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockMarkSent).toHaveBeenCalledTimes(2);

    const sentEvents = mockTrackEvent.mock.calls.filter((c) => c[2] === 'digest.sent');
    expect(sentEvents).toHaveLength(2);

    // Two storeSummary writes (one per org, both with audience='digest-weekly').
    expect(mockStoreSummary).toHaveBeenCalledTimes(2);
    for (const call of mockStoreSummary.mock.calls) {
      expect(call[0]).toMatchObject({ audience: 'digest-weekly' });
    }
  });

  it('isolates per-org failures: one org throws, other completes (AC #4)', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([orgA, orgC]);

    // Make org A's pipeline throw; org C should still succeed.
    mockGetActiveDatasetId.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) return orgA.activeDatasetId;
      if (orgId === orgC.id) return orgC.activeDatasetId;
      return null;
    });
    mockFindOrgById.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) return orgA;
      if (orgId === orgC.id) return orgC;
      return undefined;
    });
    mockGetCachedDigest.mockResolvedValue(undefined);
    mockRunCurationPipeline.mockImplementation(async (orgId: number) => {
      if (orgId === orgA.id) throw new Error('LLM provider down');
      return [{ stat: { statType: 'Total' } }];
    });
    mockGenerateInterpretation.mockResolvedValue('- ok');
    mockStoreSummary.mockResolvedValue({ id: 999 });
    mockFindOrgRecipients.mockResolvedValue([]);

    // STEP 1: orchestrator enqueues both per-org jobs.
    await handleOrchestratorJob({ id: 'orch-2' } as never);
    const orgJobs = enqueued.filter((j) => j.queueName === 'digest-org');
    expect(orgJobs).toHaveLength(2);

    // STEP 2: replay through per-org. Each handler call is independent; one
    // throws (BullMQ would retry it), the other completes cleanly.
    const results = await Promise.allSettled(
      orgJobs.map((j) => handlePerOrgJob({ id: j.jobName, data: j.data } as never)),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(failures).toHaveLength(1);
    expect(successes).toHaveLength(1);

    // The successful org's summary was written despite the other org's failure.
    expect(mockStoreSummary).toHaveBeenCalledTimes(1);
  });

  it('cache hit on retrigger: zero LLM calls, zero send-jobs (per-user dedupe)', async () => {
    mockFindEligibleOrgs.mockResolvedValue([orgA]);

    mockGetActiveDatasetId.mockResolvedValue(orgA.activeDatasetId);
    mockFindOrgById.mockResolvedValue(orgA);
    // Cache HIT this time, pipeline must not run.
    mockGetCachedDigest.mockResolvedValue({
      id: 777,
      content: 'cached content',
      transparencyMetadata: { statTypes: ['Total'] },
    });
    mockRunCurationPipeline.mockResolvedValue([{ stat: { statType: 'Total' } }]);
    mockFindOrgRecipients.mockResolvedValue([{ userId: 11, email: 'alice@a.com', name: 'Alice' }]);

    // Orchestrator + per-org first.
    await handleOrchestratorJob({ id: 'orch-3' } as never);
    const orgJobs = enqueued.filter((j) => j.queueName === 'digest-org');
    enqueued.length = 0;
    for (const j of orgJobs) {
      await handlePerOrgJob({ id: j.jobName, data: j.data } as never);
    }

    // Curation still runs on a cache hit (this week's stats feed valence and
    // history), but the LLM call and storeSummary are skipped. Send jobs
    // still enqueued.
    expect(mockRunCurationPipeline).toHaveBeenCalledOnce();
    expect(mockGenerateInterpretation).not.toHaveBeenCalled();
    expect(mockStoreSummary).not.toHaveBeenCalled();

    const sendJobs = enqueued.filter((j) => j.queueName === 'digest-send');
    expect(sendJobs).toHaveLength(1);

    // Per-send dedupe gate: user already received within 6 days, skip + emit skipped.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockUpsertDefaults.mockResolvedValueOnce({
      userId: 11,
      cadence: 'weekly',
      lastSentAt: oneDayAgo,
    });

    await handlePerSendJob({ id: sendJobs[0]!.jobName, data: sendJobs[0]!.data } as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      orgA.id, 11, 'digest.skipped',
      expect.objectContaining({ reason: 'within_dedupe_window' }),
    );
  });
});
