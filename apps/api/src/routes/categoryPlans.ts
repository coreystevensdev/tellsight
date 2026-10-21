import { Router, type Response } from 'express';
import { z } from 'zod';
import { categoryPlansInputSchema } from 'shared/schemas';
import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { categoryPlansQueries } from '../db/queries/index.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';

export const categoryPlansRouter = Router();

// Reading is a member-level concern, writing is not: a plan is the owner's
// statement of intent for the business, and the variance stat that reads it
// goes into the weekly digest every member receives.
categoryPlansRouter.get('/category-plans', async (req, res: Response) => {
  const user = requireUser(req);
  const plans = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    categoryPlansQueries.listCategoryPlans(user.org_id, tx),
  );
  res.json({ data: plans });
});

categoryPlansRouter.put('/category-plans', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const parsed = categoryPlansInputSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid category plans',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const plans = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    categoryPlansQueries.upsertCategoryPlans(user.org_id, parsed.data.plans, tx),
  );

  const categories = parsed.data.plans.map((p) => p.category);

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.CATEGORY_PLANS_UPDATED, {
    categoryCount: categories.length,
  });

  // Categories, not amounts. Same rule the financials audit follows: what an
  // owner budgets is as sensitive as what they hold, and the current values are
  // already readable from category_plans for point-in-time questions.
  auditAuth(req, AUDIT_ACTIONS.CATEGORY_PLANS_UPDATED, {
    metadata: { categories },
  });

  res.json({ data: plans });
});

// Path param rather than a body, because deleting is identified by the thing
// itself. Categories are free text from the source data, so they arrive
// percent-encoded and can contain spaces and ampersands.
const categoryParamSchema = z.object({ category: z.string().min(1).max(255) });

categoryPlansRouter.delete(
  '/category-plans/:category',
  roleGuard('owner'),
  async (req, res: Response) => {
    const user = requireUser(req);
    const parsed = categoryParamSchema.safeParse(req.params);

    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid category', details: parsed.error.flatten() },
      });
      return;
    }

    const removed = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
      categoryPlansQueries.deleteCategoryPlan(user.org_id, parsed.data.category, tx),
    );

    // 404 rather than 204 for a category that had no plan. deleteCategoryPlan
    // returns whether a row actually went, so the caller can tell "removed" from
    // "there was nothing there", which matters when the UI is reconciling state.
    if (!removed) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No plan set for that category' },
      });
      return;
    }

    auditAuth(req, AUDIT_ACTIONS.CATEGORY_PLANS_UPDATED, {
      metadata: { categories: [parsed.data.category], removed: true },
    });

    res.status(204).send();
  },
);
