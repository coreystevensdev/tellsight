import { agentProposalsQueries, subscriptionsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

const PROPOSAL_FOLD_IN_CAP = 5;

export interface DigestAgentFindings {
  bullets: string[];
  notifiedProposalIds: number[];
}

export async function loadDigestAgentFindings(
  orgId: number,
  weekStart: Date,
  correlationId: string,
): Promise<DigestAgentFindings> {
  let autoNotify: Awaited<ReturnType<typeof agentProposalsQueries.getPendingProposals>> = [];
  let expired: Awaited<
    ReturnType<typeof agentProposalsQueries.getExpiredUnfoldedProposals>
  > = [];
  let expiredTotal = 0;

  try {
    const agentEnabled = await subscriptionsQueries.getAgentEnabled(orgId, dbAdmin);
    if (agentEnabled) {
      const pending = await agentProposalsQueries.getPendingProposals(orgId);
      autoNotify = pending.filter((proposal) => proposal.lane === 'auto_notify');
      expired = await agentProposalsQueries.getExpiredUnfoldedProposals(
        orgId,
        weekStart,
        PROPOSAL_FOLD_IN_CAP,
      );
      expiredTotal = expired.length;
      expiredTotal = await agentProposalsQueries.countExpiredUnfoldedProposals(orgId, weekStart);
    }
  } catch (err) {
    logger.error(
      { correlationId, orgId, err },
      'Failed to fetch some agent proposals for the digest, continuing with whatever was already fetched',
    );
  }

  const shownAutoNotify = autoNotify.slice(0, PROPOSAL_FOLD_IN_CAP);
  const omitted =
    Math.max(0, autoNotify.length - PROPOSAL_FOLD_IN_CAP) +
    Math.max(0, expiredTotal - expired.length);
  const bullets = [
    ...shownAutoNotify.map((proposal) => `${proposal.title}: ${proposal.recommendation}`),
    ...expired.map(
      (proposal) =>
        `${proposal.title} (expired without review): ${proposal.recommendation}`,
    ),
  ];
  if (omitted > 0) {
    bullets.push(`+${omitted} more agent finding${omitted === 1 ? '' : 's'} not shown this week`);
  }

  return {
    bullets,
    notifiedProposalIds: [...shownAutoNotify, ...expired].map((proposal) => proposal.id),
  };
}
