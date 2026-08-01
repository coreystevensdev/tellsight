import { Router, type Response } from 'express';
import { AUDIT_ACTIONS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { audit } from '../services/audit/auditService.js';
import { getPendingProposals, resolveProposal } from '../db/queries/agentProposals.js';
import { subscriptionsQueries } from '../db/queries/index.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

export const proposalsRouter = Router();

// Hard gate, not subscriptionGate's annotate-not-block posture: a proposal
// list the org isn't entitled to has no partial/preview shape to fall back
// to. Same reasoning and shape as qa.ts's AGENT_TIER_REQUIRED gate. Catches
// withRlsContext throwing before getAgentEnabled's own fail-closed catch
// runs, routing that failure through the fail-closed 403 instead of a 500.
async function requireAgentTier(orgId: number, isAdmin: boolean): Promise<boolean> {
  try {
    return await withRlsContext(orgId, isAdmin, (tx) =>
      subscriptionsQueries.getAgentEnabled(orgId, tx),
    );
  } catch (err) {
    logger.warn({ orgId, err: (err as Error).message }, 'agent entitlement lookup failed, defaulting to disabled');
    return false;
  }
}

proposalsRouter.get('/', async (req, res: Response) => {
  const user = requireUser(req);

  const agentEnabled = await requireAgentTier(user.org_id, user.isAdmin);
  if (!agentEnabled) {
    res.status(403).json({
      error: { code: 'AGENT_TIER_REQUIRED', message: 'Agent proposals require the Agent tier' },
    });
    return;
  }

  const proposals = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    getPendingProposals(user.org_id, tx),
  );

  res.json({ data: proposals });
});

// Owner-only: 18.4's AC requires approval to be gated to org Owners, not any
// authenticated member. roleGuard runs as route middleware before this body,
// so a non-owner without entitlement sees the role error first, not
// AGENT_TIER_REQUIRED -- the entitlement check below only needs to guarantee
// that an owner lacking the entitlement gets AGENT_TIER_REQUIRED.
proposalsRouter.patch('/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);

  const agentEnabled = await requireAgentTier(user.org_id, user.isAdmin);
  if (!agentEnabled) {
    res.status(403).json({
      error: { code: 'AGENT_TIER_REQUIRED', message: 'Agent proposals require the Agent tier' },
    });
    return;
  }

  const userId = parseInt(user.sub, 10);
  const proposalId = parseInt(req.params.id as string, 10);

  if (isNaN(proposalId)) {
    throw new ValidationError('Invalid proposal id');
  }

  const { status } = req.body as { status: unknown };
  if (status !== 'approved' && status !== 'rejected') {
    throw new ValidationError('status must be "approved" or "rejected"');
  }

  const row = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    resolveProposal(proposalId, status, userId, user.org_id, tx),
  );
  if (!row) {
    throw new NotFoundError('Proposal not found or already resolved');
  }

  audit(req, {
    orgId: user.org_id,
    userId,
    action: status === 'approved' ? AUDIT_ACTIONS.PROPOSAL_APPROVED : AUDIT_ACTIONS.PROPOSAL_REJECTED,
    targetType: 'agent_proposal',
    targetId: String(proposalId),
    metadata: { status },
  });

  res.json({ data: { id: row.id } });
});
