import { Router, type Response } from 'express';
import { createAlertRuleSchema, updateAlertRuleSchema } from 'shared/schemas';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { alertRulesQueries } from '../db/queries/index.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { trackEvent } from '../services/analytics/trackEvent.js';

export const alertRulesRouter = Router();

function parseRuleId(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  // /^\d+$/ instead of a bare parseInt + isNaN check: parseInt('5abc', 10)
  // returns 5, it doesn't reject the trailing garbage.
  if (!value || !/^\d+$/.test(value)) throw new ValidationError('Invalid alert rule id');
  return parseInt(value, 10);
}

alertRulesRouter.get('/alert-rules', async (req, res: Response) => {
  const user = requireUser(req);
  const rules = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    alertRulesQueries.getByOrgId(user.org_id, tx),
  );
  res.json({ data: rules });
});

alertRulesRouter.post('/alert-rules', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const userId = parseInt(user.sub, 10);
  const parsed = createAlertRuleSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid alert rule',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const rule = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    alertRulesQueries.create(user.org_id, userId, parsed.data, tx),
  );

  trackEvent(user.org_id, userId, ANALYTICS_EVENTS.ALERT_RULE_CREATED, {
    ruleId: rule.id,
    ruleKind: rule.kind,
  });

  // req.log (not the bare logger) so correlationId rides along automatically,
  // the intent-contract requires it on every CRUD mutation line.
  req.log.info(
    { orgId: user.org_id, userId, ruleId: rule.id, ruleKind: rule.kind, action: 'created' },
    'Alert rule created',
  );

  res.status(201).json({ data: rule });
});

alertRulesRouter.put('/alert-rules/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const userId = parseInt(user.sub, 10);
  const ruleId = parseRuleId(req.params.id);
  const parsed = updateAlertRuleSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid alert rule',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  // Scoped by orgId inside the query, so a ruleId from another org resolves
  // to no row here, RLS backs this up at the DB layer too, defense in depth.
  const rule = await withRlsContext(user.org_id, user.isAdmin, async (tx) => {
    const updated = await alertRulesQueries.update(user.org_id, ruleId, parsed.data, tx);
    if (!updated) throw new NotFoundError('Alert rule not found');
    return updated;
  });

  trackEvent(user.org_id, userId, ANALYTICS_EVENTS.ALERT_RULE_UPDATED, {
    ruleId: rule.id,
    ruleKind: rule.kind,
  });

  req.log.info(
    { orgId: user.org_id, userId, ruleId: rule.id, ruleKind: rule.kind, action: 'updated' },
    'Alert rule updated',
  );

  res.json({ data: rule });
});

alertRulesRouter.delete('/alert-rules/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const userId = parseInt(user.sub, 10);
  const ruleId = parseRuleId(req.params.id);

  const rule = await withRlsContext(user.org_id, user.isAdmin, async (tx) => {
    const deleted = await alertRulesQueries.softDelete(user.org_id, ruleId, tx);
    if (!deleted) throw new NotFoundError('Alert rule not found');
    return deleted;
  });

  trackEvent(user.org_id, userId, ANALYTICS_EVENTS.ALERT_RULE_DELETED, {
    ruleId: rule.id,
    ruleKind: rule.kind,
  });

  req.log.info(
    { orgId: user.org_id, userId, ruleId: rule.id, ruleKind: rule.kind, action: 'deleted' },
    'Alert rule deleted',
  );

  res.json({ data: { deleted: true } });
});
