import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';

import { AUDIT_ACTIONS } from 'shared/constants';

import { userOrgsQueries } from '../db/queries/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/appError.js';
import { dbAdmin } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../lib/requireUser.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { audit } from '../services/audit/auditService.js';

export const orgMembersRouter = Router();

const userIdParam = z.coerce.number().int().positive();

orgMembersRouter.get('/members', roleGuard('owner'), async (req, res: Response) => {
  const caller = requireUser(req);
  const members = await userOrgsQueries.getOrgMembers(caller.org_id, dbAdmin);

  res.json({
    // isSelf comes from the server because the browser has no session context to
    // compare against, and the row it marks is the one with no remove button.
    // The route refuses self-removal either way.
    data: members.map((m) => ({
      isSelf: m.userId === Number(caller.sub),
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
    })),
  });
});

orgMembersRouter.delete('/members/:userId', roleGuard('owner'), async (req, res: Response) => {
  const caller = requireUser(req);
  const parsed = userIdParam.safeParse(req.params.userId);
  if (!parsed.success) throw new ValidationError('Invalid user ID');

  const targetId = parsed.data;

  // An owner removing themselves is how an org ends up with members and nobody
  // who can bill, invite or delete it. It is also not what this route is for:
  // leaving is account deletion, which knows how to hand the org over first.
  // Blocking it is what keeps the last owner in place, since whoever is calling
  // is an owner and therefore still here afterwards.
  if (targetId === Number(caller.sub)) {
    throw new ConflictError('Owners cannot remove themselves, delete your account instead');
  }

  const removed = await userOrgsQueries.removeMember(caller.org_id, targetId, dbAdmin);
  if (!removed) throw new NotFoundError('That person is not in this organization');

  audit(req, {
    orgId: caller.org_id,
    userId: Number(caller.sub),
    action: AUDIT_ACTIONS.ORG_MEMBER_REMOVED,
    targetType: 'user',
    targetId: String(targetId),
  });

  logger.info({ orgId: caller.org_id, targetId, role: removed.role }, 'Member removed from org');
  res.json({ data: { userId: targetId } });
});
