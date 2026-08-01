import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';
import { routeProposal, type GateConfig, type GateContext } from 'shared/agent';
import type { AgentProposal } from 'shared/agent';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import {
  subscriptionsQueries,
  orgsQueries,
  agentProposalsQueries,
  statCorrectionsQueries,
} from '../../../db/queries/index.js';
import { runCurationPipeline } from '../../../services/curation/index.js';
import { generateProposals } from '../../../services/curation/proposals.js';
import { evaluateOrgJobDataSchema } from '../queue.js';

const DEDUP_WINDOW_DAYS = 14;
const EXPIRY_DAYS = 14;
const APPROVAL_THRESHOLD_USD = 1000;

const GATE_CONFIG: GateConfig = {
  approvalThreshold: APPROVAL_THRESHOLD_USD,
  suppressSeenDays: DEDUP_WINDOW_DAYS,
};

async function persistProposal(
  orgId: number,
  proposal: AgentProposal,
  lane: 'needs_approval' | 'auto_notify',
  now: Date,
): Promise<number> {
  const row = await agentProposalsQueries.insertProposal({
    orgId,
    kind: proposal.kind,
    severity: proposal.severity,
    title: proposal.title,
    explanation: proposal.explanation,
    recommendation: proposal.recommendation,
    confidence: proposal.confidence.toFixed(3),
    evidence: proposal.evidence,
    action: proposal.action ?? null,
    dedupKey: proposal.dedupKey,
    lane,
    period: proposal.period,
    status: 'pending',
    expiresAt: new Date(now.getTime() + EXPIRY_DAYS * 86_400_000),
  });
  return row.id;
}

/**
 * Per-org evaluator. Re-verifies the Agent-tier entitlement and active
 * dataset itself regardless of what the eligibility query found:
 * findEligibleOrgs (cron) is a courtesy pre-filter, not the sole gate, since
 * an org can lose entitlement between paging and processing.
 */
export async function handleEvaluateOrgJob(job: Job): Promise<void> {
  const parsed = evaluateOrgJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.warn(
      {
        correlationId: typeof job.data?.correlationId === 'string' ? job.data.correlationId : undefined,
        jobId: job.id,
        issues: parsed.error.issues,
      },
      'invalid job payload, skipping',
    );
    return;
  }

  const { orgId, correlationId } = parsed.data;
  const start = Date.now();
  const now = new Date();

  const agentEnabled = await subscriptionsQueries.getAgentEnabled(orgId, dbAdmin);
  if (!agentEnabled) {
    logger.info(
      { correlationId, orgId, outcome: 'skipped', durationMs: Date.now() - start },
      'Agent evaluation skipped: org entitlement revoked since enqueue',
    );
    return;
  }

  // Always re-fetched, never trusted from job.data: an org can swap its
  // active dataset between the job being enqueued and this worker picking
  // it up, same re-verification reasoning as the entitlement check above.
  const datasetId = await orgsQueries.getActiveDatasetId(orgId, dbAdmin);
  if (datasetId === null || datasetId === undefined) {
    logger.info(
      { correlationId, orgId, outcome: 'skipped', durationMs: Date.now() - start },
      'Agent evaluation skipped: org has no active dataset',
    );
    return;
  }

  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    logger.warn(
      { correlationId, orgId, outcome: 'skipped', durationMs: Date.now() - start },
      'Agent evaluation skipped: org row missing',
    );
    return;
  }

  const businessProfile = (org.businessProfile ?? null) as BusinessProfile | null;
  const financials = businessProfile
    ? {
        cashOnHand: businessProfile.cashOnHand,
        cashAsOfDate: businessProfile.cashAsOfDate,
        businessStartedDate: businessProfile.businessStartedDate,
        monthlyFixedCosts: businessProfile.monthlyFixedCosts,
      }
    : null;

  const activeCorrectionIds = await statCorrectionsQueries.getActiveCorrectionStatIds(orgId, dbAdmin);
  const insights = await runCurationPipeline(orgId, datasetId, dbAdmin, financials, activeCorrectionIds);

  const proposals = await generateProposals(insights, datasetId, businessProfile, now);

  const dedupSince = new Date(now.getTime() - DEDUP_WINDOW_DAYS * 86_400_000);
  const recentDedupKeys = await agentProposalsQueries.getRecentDedupKeys(orgId, dedupSince, dbAdmin);
  const gateContext: GateContext = { recentDedupKeys: new Set(recentDedupKeys) };

  let suppressedCount = 0;
  let notifyCount = 0;
  let approvalCount = 0;

  for (const proposal of proposals) {
    const decision = routeProposal(proposal, GATE_CONFIG, gateContext);

    if (decision.lane === 'suppress') {
      suppressedCount++;
      logger.info(
        { correlationId, orgId, proposalKind: proposal.kind, lane: decision.lane, reason: decision.reason },
        'Agent proposal routed',
      );
      continue;
    }

    const proposalId = await persistProposal(orgId, proposal, decision.lane, now);
    if (decision.lane === 'needs_approval') approvalCount++;
    else notifyCount++;

    logger.info(
      {
        correlationId,
        orgId,
        proposalKind: proposal.kind,
        lane: decision.lane,
        reason: decision.reason,
        proposalId,
      },
      'Agent proposal routed',
    );
  }

  logger.info(
    {
      correlationId,
      orgId,
      datasetId,
      proposalCount: proposals.length,
      notifyCount,
      approvalCount,
      suppressedCount,
      durationMs: Date.now() - start,
    },
    'Agent evaluation complete',
  );
}
