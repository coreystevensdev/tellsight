import { Router, type Response } from 'express';
import { AUDIT_ACTIONS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { audit } from '../services/audit/auditService.js';
import { getPendingProposals, resolveProposal } from '../db/queries/agentProposals.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';

export const proposalsRouter = Router();

proposalsRouter.get('/', async (req, res: Response) => {
  const user = requireUser(req);

  const proposals = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    getPendingProposals(user.org_id, tx),
  );

  res.json({ data: proposals });
});

// Owner-only: 18.4's AC requires approval to be gated to org Owners, not any
// authenticated member.
proposalsRouter.patch('/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
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
