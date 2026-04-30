import { Router } from 'express';
import type { Request, Response } from 'express';
import { AUTH, ANALYTICS_EVENTS } from 'shared/constants';
import { chartFiltersSchema } from 'shared/schemas';
import type { DemoModeState } from 'shared/types';
import { verifyAccessToken } from '../services/auth/tokenService.js';
import { AuthenticationError } from '../lib/appError.js';
import { aiSummariesQueries, chartsQueries, dataRowsQueries, datasetsQueries, orgsQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { withRlsContext } from '../lib/rls.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';

const dashboardRouter = Router();

function parseFilterParams(query: Request['query']) {
  const raw = {
    dateFrom: typeof query.from === 'string' ? query.from : undefined,
    dateTo: typeof query.to === 'string' ? query.to : undefined,
    categories: typeof query.categories === 'string' && query.categories
      ? query.categories.split(',').slice(0, 20)
      : undefined,
    granularity: typeof query.granularity === 'string' ? query.granularity : undefined,
  };

  const result = chartFiltersSchema.safeParse(raw);
  if (!result.success) return { dateFrom: undefined, dateTo: undefined, categories: undefined, granularity: undefined };

  return {
    dateFrom: result.data.dateFrom,
    dateTo: result.data.dateTo,
    categories: result.data.categories,
    granularity: result.data.granularity,
  };
}

function hasFilters(filters: ReturnType<typeof parseFilterParams>): boolean {
  return !!(filters.dateFrom || filters.dateTo || filters.categories || filters.granularity);
}

// public, unauthenticated visitors get seed org
dashboardRouter.get('/dashboard/charts', async (req: Request, res: Response) => {
  const filters = parseFilterParams(req.query);
  const filterArg = hasFilters(filters) ? filters : undefined;
  const token = req.cookies?.[AUTH.COOKIE_NAMES.ACCESS_TOKEN];

  if (token) {
    try {
      const payload = await verifyAccessToken(token);
      const orgId = payload.org_id;
      const userId = Number(payload.sub);

      // orgs table has no org_id, intentional RLS exception
      const org = await orgsQueries.findOrgById(orgId);
      const orgName = org?.name ?? 'Your Organization';

      // data_rows + datasets are RLS-enabled, run inside tenant context
      const { chartData, datasets, demoState, activeDatasetId, datasetRowCount, hasMarginSignal } = await withRlsContext(
        orgId,
        payload.isAdmin,
        async (tx) => {
          const [ds, activeId] = await Promise.all([
            datasetsQueries.getDatasetsByOrg(orgId, tx),
            orgsQueries.getActiveDatasetId(orgId, tx),
          ]);
          let state: DemoModeState;
          try {
            state = await datasetsQueries.getUserOrgDemoState(orgId, tx);
          } catch {
            state = 'empty';
          }

          // three-tier: query param → active → newest
          const requestedId = typeof req.query.dataset === 'string'
            ? parseInt(req.query.dataset, 10)
            : NaN;
          const requestedValid = Number.isInteger(requestedId) && requestedId > 0
            && ds.some((d) => d.id === requestedId);

          const resolvedId = requestedValid
            ? requestedId
            : (activeId != null && ds.some((d) => d.id === activeId) ? activeId : ds[0]?.id ?? null);

          const [cd, rowCount, marginSignal] = await Promise.all([
            chartsQueries.getChartData(orgId, filterArg, undefined, tx, resolvedId ?? undefined),
            resolvedId != null
              ? dataRowsQueries.getRowCount(orgId, resolvedId, tx)
              : Promise.resolve(0),
            resolvedId != null
              ? chartsQueries.getHasMarginSignal(orgId, tx, resolvedId)
              : Promise.resolve(false),
          ]);

          return { chartData: cd, datasets: ds, demoState: state, activeDatasetId: resolvedId, datasetRowCount: rowCount, hasMarginSignal: marginSignal };
        },
      );

      const resolvedDataset = datasets.find((d) => d.id === activeDatasetId) ?? datasets[0] ?? null;
      const datasetId = resolvedDataset?.id ?? null;
      const datasetName = resolvedDataset?.name ?? null;

      trackEvent(orgId, userId, ANALYTICS_EVENTS.DASHBOARD_VIEWED, {
        isDemo: false,
        chartCount: chartData.revenueTrend.length + chartData.expenseBreakdown.length,
      });

      // chart.filtered tracking moved client-side (FilterBar.tsx), richer metadata + no double-counting on page reload

      logger.info({ orgId, isDemo: false, filtered: hasFilters(filters) }, 'Dashboard charts served');

      res.json({
        data: { ...chartData, orgName, isDemo: false, demoState, datasetId, datasetName, datasetRowCount, hasMarginSignal },
      });
      return;
    } catch (err) {
      if (!(err instanceof AuthenticationError)) throw err;
      // expired or invalid token, fall through to seed org
    }
  }

  // unauthenticated, seed org via dbAdmin (no tenant context)
  const orgId = await orgsQueries.getSeedOrgId();
  const [chartData, datasets, hasMarginSignal] = await Promise.all([
    chartsQueries.getChartData(orgId, filterArg, undefined, dbAdmin),
    datasetsQueries.getDatasetsByOrg(orgId, dbAdmin),
    chartsQueries.getHasMarginSignal(orgId, dbAdmin),
  ]);
  const datasetId = datasets[0]?.id ?? null;

  logger.info({ orgId, isDemo: true, filtered: hasFilters(filters) }, 'Dashboard charts served');

  res.json({
    data: { ...chartData, orgName: 'Sunrise Cafe', isDemo: true, demoState: 'seed_only', datasetId, hasMarginSignal },
  });
});

// public, returns cached AI summary for seed datasets (anonymous visitors)
dashboardRouter.get('/ai-summaries/:datasetId/cached', async (req: Request, res: Response) => {
  const rawId = Number(req.params.datasetId);
  if (!Number.isInteger(rawId) || rawId <= 0) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid datasetId' } });
    return;
  }

  const seedOrgId = await orgsQueries.getSeedOrgId();
  const latest = await aiSummariesQueries.getLatestSummary(seedOrgId, rawId, dbAdmin);

  if (!latest) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No cached summary' } });
    return;
  }

  res.json({
    data: {
      content: latest.content,
      metadata: latest.transparencyMetadata ?? null,
      staleAt: latest.staleAt ? latest.staleAt.toISOString() : null,
    },
  });
});

export default dashboardRouter;
