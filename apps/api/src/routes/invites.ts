import { Router } from 'express';
import type { Response } from 'express';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { generateInvite, validateInviteToken, getActiveInvitesForOrg } from '../services/auth/index.js';
import { withRlsContext } from '../lib/rls.js';
import { env } from '../config.js';
import { z } from 'zod';
import { createInviteSchema, inviteTokenParamSchema } from 'shared/schemas';
import { AUDIT_ACTIONS } from 'shared/constants';
import { orgInvitesQueries } from '../db/queries/index.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { auditAuth } from '../services/audit/auditService.js';

export const inviteRouter = Router();

inviteRouter.get('/', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);

  const invites = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    getActiveInvitesForOrg(user.org_id, tx),
  );

  const safe = invites.map((inv) => ({
    id: inv.id,
    expiresAt: inv.expiresAt,
    createdBy: inv.createdBy,
    createdAt: inv.createdAt,
  }));

  res.json({ data: safe });
});

// An invite is a bearer token that lets whoever holds it join. Removing someone
// meant nothing while an unused link for the org was still out there, and the
// list above could show one without being able to cancel it.
inviteRouter.delete('/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const parsed = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!parsed.success) throw new ValidationError('Invalid invite ID');

  const revoked = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    orgInvitesQueries.deleteInvite(user.org_id, parsed.data, tx),
  );
  if (!revoked) throw new NotFoundError('No such invite');

  auditAuth(req, AUDIT_ACTIONS.ORG_INVITE_REVOKED, {
    targetType: 'invite',
    targetId: String(parsed.data),
  });

  res.json({ data: { id: parsed.data } });
});

inviteRouter.post('/', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);

  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid invite parameters', parsed.error.format());
  }

  const { token, expiresAt } = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    generateInvite(user.org_id, parseInt(user.sub, 10), parsed.data.expiresInDays, tx),
  );

  const url = `${env.APP_URL}/invite/${token}`;

  res.status(201).json({
    data: { url, token, expiresAt },
  });
});

// public router, no auth required
export const publicInviteRouter = Router();

// GET /invites/:token, validates an invite (anyone can check)
publicInviteRouter.get('/invites/:token', async (req, res: Response) => {
  const parsed = inviteTokenParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new ValidationError('Invalid invite token');
  }

  const invite = await validateInviteToken(parsed.data.token);

  res.json({
    data: {
      orgName: invite.org.name,
      expiresAt: invite.expiresAt,
    },
  });
});
