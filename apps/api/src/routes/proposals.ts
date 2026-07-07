import { Router, type Request, type Response } from 'express';
import { getPendingProposals, resolveProposal } from '../db/queries/agentProposals.js';

export const proposalsRouter = Router();

proposalsRouter.get('/', async (req: Request, res: Response) => {
  const orgId = req.user!.org_id;
  const proposals = await getPendingProposals(orgId);
  res.json(proposals);
});

proposalsRouter.patch('/:id', async (req: Request, res: Response) => {
  const orgId = req.user!.org_id;
  const userId = parseInt(req.user!.sub, 10);
  const proposalId = parseInt(req.params.id as string, 10);

  if (isNaN(proposalId)) {
    res.status(400).json({ error: 'invalid proposal id' });
    return;
  }

  const { status } = req.body as { status: unknown };
  if (status !== 'approved' && status !== 'rejected') {
    res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    return;
  }

  const row = await resolveProposal(proposalId, status, userId, orgId);
  if (!row) {
    res.status(404).json({ error: 'Proposal not found or already resolved' });
    return;
  }

  res.json({ id: row.id });
});
