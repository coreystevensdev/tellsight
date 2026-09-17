import { Router, type Request, type Response } from 'express';

import { AUTH, AUDIT_ACTIONS } from 'shared/constants';

import { clearCookie } from '../lib/cookies.js';
import { requireUser } from '../lib/requireUser.js';
import { audit } from '../services/audit/auditService.js';
import { deleteAccount } from '../services/auth/accountDeletion.js';

export const accountRouter = Router();

accountRouter.delete('/', async (req: Request, res: Response) => {
  const user = requireUser(req);

  // Written before the row it refers to disappears. auditLogs.user_id is set
  // null on delete, so the entry survives with the action and the org, minus
  // the person, which is the point.
  audit(req, {
    orgId: user.org_id,
    userId: Number(user.sub),
    action: AUDIT_ACTIONS.ACCOUNT_DELETED,
  });

  const result = await deleteAccount(Number(user.sub));

  clearCookie(res, AUTH.COOKIE_NAMES.ACCESS_TOKEN);
  clearCookie(res, AUTH.COOKIE_NAMES.REFRESH_TOKEN);

  res.json({ data: result });
});
