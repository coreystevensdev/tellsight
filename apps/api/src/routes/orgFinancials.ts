import { Router, type Response } from 'express';
import { z } from 'zod';
import { orgFinancialsSchema } from 'shared/schemas';
import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { orgFinancialsQueries, orgsQueries, dataRowsQueries } from '../db/queries/index.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { rateLimitDashboardCompute } from '../middleware/rateLimiter.js';
import { logger } from '../lib/logger.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { auditAuth } from '../services/audit/auditService.js';
import {
  cashFlowFromBuckets,
  computeCashForecast,
  netsFromBuckets,
} from '../services/curation/computation.js';

export const orgFinancialsRouter = Router();

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

const forecastQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(3).optional(),
});

orgFinancialsRouter.get('/financials', async (req, res: Response) => {
  const user = requireUser(req);
  const financials = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    orgFinancialsQueries.getOrgFinancials(user.org_id, tx),
  );
  res.json({ data: financials ?? {} });
});

orgFinancialsRouter.put('/financials', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const parsed = orgFinancialsSchema.partial().safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid financial baseline',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  // Default cashAsOfDate to "now" when cashOnHand is set without an explicit date —
  // owners shouldn't have to type today's date every time they update their balance.
  const updates = { ...parsed.data };
  if (updates.cashOnHand != null && !updates.cashAsOfDate) {
    updates.cashAsOfDate = new Date().toISOString();
  }

  const before = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    orgFinancialsQueries.getOrgFinancials(user.org_id, tx),
  );
  const updated = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    orgFinancialsQueries.updateOrgFinancials(user.org_id, updates, tx),
  );

  const fieldsUpdated = Object.keys(updates);
  const firstCashBalance = updates.cashOnHand != null && before?.cashOnHand == null;

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.FINANCIALS_UPDATED, {
    fields: fieldsUpdated,
  });

  // Audit: owners editing financial baseline is the kind of change that
  // shows up in support disputes ("my runway calculation is wrong"). Log
  // which fields changed, not the values — balance amounts are sensitive
  // and already live in cash_balance_snapshots for point-in-time recovery.
  auditAuth(req, AUDIT_ACTIONS.FINANCIALS_UPDATED, {
    metadata: { fields: fieldsUpdated, firstCashBalance },
  });

  // Adoption signal — the moment an owner sets their first cash balance is when
  // runway becomes reachable for their account. Tracked separately from the
  // generic update event for cleaner funnel queries.
  if (firstCashBalance) {
    trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.RUNWAY_ENABLED, {
      cashOnHand: updates.cashOnHand,
    });
  }

  logger.info({ orgId: user.org_id, fieldsUpdated, firstCashBalance }, 'Financials updated');

  res.json({ data: updated ?? {} });
});

orgFinancialsRouter.get('/financials/cash-history', rateLimitDashboardCompute, async (req, res: Response) => {
  const user = requireUser(req);
  const q = historyQuerySchema.safeParse(req.query);

  if (!q.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid limit parameter' },
    });
    return;
  }

  const history = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    orgFinancialsQueries.getCashBalanceHistory(user.org_id, q.data.limit ?? 12, tx),
  );

  res.json({ data: history });
});

// Cash forecast — derived from monthly net trend + current cashOnHand. Returns
// a three-month point-estimate trajectory plus metadata (method, confidence,
// crossesZeroAtMonth). Suppression cases return `{ data: null }` so the client
// can render the same empty state as RunwayTrendChart when the forecast is
// unavailable.
orgFinancialsRouter.get('/financials/cash-forecast', rateLimitDashboardCompute, async (req, res: Response) => {
  const user = requireUser(req);
  const q = forecastQuerySchema.safeParse(req.query);

  if (!q.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid months parameter' },
    });
    return;
  }

  const { financials, buckets } = await withRlsContext(user.org_id, user.isAdmin, async (tx) => {
    const financials = await orgFinancialsQueries.getOrgFinancials(user.org_id, tx);
    const datasetId = await orgsQueries.getActiveDatasetId(user.org_id, tx);
    // SQL-aggregated bucket map instead of full row fetch — a 50k-row dataset
    // collapses to ~12-60 rows at the DB layer, so API memory stays bounded.
    const buckets = datasetId != null
      ? await dataRowsQueries.getMonthlyBucketsByDataset(user.org_id, datasetId, tx)
      : new Map();
    return { financials, buckets };
  });

  if (buckets.size === 0) {
    res.json({ data: null });
    return;
  }

  const cashFlow = cashFlowFromBuckets(buckets);
  const monthlyNets = netsFromBuckets(buckets, 12);
  const forecast = computeCashForecast(cashFlow, financials ?? null, monthlyNets);

  if (forecast.length === 0) {
    res.json({ data: null });
    return;
  }

  const d = forecast[0]!.details;

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.FORECAST_REQUESTED, {
    confidence: d.confidence,
    crossesZeroAtMonth: d.crossesZeroAtMonth,
    method: d.method,
  });

  res.json({
    data: {
      startingBalance: d.startingBalance,
      asOfDate: d.asOfDate,
      method: d.method,
      confidence: d.confidence,
      crossesZeroAtMonth: d.crossesZeroAtMonth,
      forecast: d.projectedMonths.map((pm) => ({
        month: pm.month,
        projectedNet: pm.projectedNet,
        projectedBalance: pm.projectedBalance,
        // Shortcut: duplicate balance/asOfDate so the client can spread each
        // forecast row straight into `CashBalancePoint[]` without a transform.
        // Couples this API response to a specific UI type — if CashBalancePoint
        // ever grows (e.g., per-point confidence), move the field aliasing into
        // the SWR fetcher and drop the duplicates here.
        balance: pm.projectedBalance,
        asOfDate: `${pm.month}-01`,
      })),
    },
  });
});
