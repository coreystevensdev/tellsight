import { Router } from 'express';
import type { Request, Response } from 'express';
import { AUTH, ANALYTICS_EVENTS } from 'shared/constants';
import { chartFiltersSchema } from 'shared/schemas';
import type { DemoModeState } from 'shared/types';
import { verifyAccessToken } from '../services/auth/tokenService.js';
import { AuthenticationError } from '../lib/appError.js';
import { aiSummariesQueries, chartsQueries, datasetsQueries, orgsQueries } from '../db/queries/index.js';
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
  return !!(filters.dateFrom || filters.dateTo || filters.categories);
}

// public — unauthenticated visitors get seed org
dashboardRouter.get('/dashboard/charts', async (req: Request, res: Response) => {
  const filters = parseFilterParams(req.query);
  const filterArg = hasFilters(filters) ? filters : undefined;
  const token = req.cookies?.[AUTH.COOKIE_NAMES.ACCESS_TOKEN];

  if (token) {
    try {
      const payload = await verifyAccessToken(token);
      const orgId = payload.org_id;
      const userId = Number(payload.sub);

      // orgs table has no org_id — intentional RLS exception
      const org = await orgsQueries.findOrgById(orgId);
      const orgName = org?.name ?? 'Your Organization';

      // data_rows + datasets are RLS-enabled — run inside tenant context
      const { chartData, datasets, demoState } = await withRlsContext(
        orgId,
        payload.isAdmin,
        async (tx) => {
          const [cd, ds] = await Promise.all([
            chartsQueries.getChartData(orgId, filterArg, undefined, tx),
            datasetsQueries.getDatasetsByOrg(orgId, tx),
          ]);
          let state: DemoModeState;
          try {
            state = await datasetsQueries.getUserOrgDemoState(orgId, tx);
          } catch {
            state = 'empty';
          }
          return { chartData: cd, datasets: ds, demoState: state };
        },
      );

      const datasetId = datasets[0]?.id ?? null;

      trackEvent(orgId, userId, ANALYTICS_EVENTS.DASHBOARD_VIEWED, {
        isDemo: false,
        chartCount: chartData.revenueTrend.length + chartData.expenseBreakdown.length,
      });

      // chart.filtered tracking moved client-side (FilterBar.tsx) — richer metadata + no double-counting on page reload

      logger.info({ orgId, isDemo: false, filtered: hasFilters(filters) }, 'Dashboard charts served');

      res.json({
        data: { ...chartData, orgName, isDemo: false, demoState, datasetId },
      });
      return;
    } catch (err) {
      if (!(err instanceof AuthenticationError)) throw err;
      // expired or invalid token — fall through to seed org
    }
  }

  // unauthenticated — seed org via dbAdmin (no tenant context)
  const orgId = await orgsQueries.getSeedOrgId();
  const [chartData, datasets] = await Promise.all([
    chartsQueries.getChartData(orgId, filterArg, undefined, dbAdmin),
    datasetsQueries.getDatasetsByOrg(orgId, dbAdmin),
  ]);
  const datasetId = datasets[0]?.id ?? null;

  logger.info({ orgId, isDemo: true, filtered: hasFilters(filters) }, 'Dashboard charts served');

  res.json({
    data: { ...chartData, orgName: 'Sunrise Cafe', isDemo: true, demoState: 'seed_only', datasetId },
  });
});

// public — returns cached AI summary for seed datasets (anonymous visitors)
dashboardRouter.get('/ai-summaries/:datasetId/cached', async (req: Request, res: Response) => {
  const rawId = Number(req.params.datasetId);
  if (!Number.isInteger(rawId) || rawId <= 0) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid datasetId' } });
    return;
  }

  const seedOrgId = await orgsQueries.getSeedOrgId();
  const cached = await aiSummariesQueries.getCachedSummary(seedOrgId, rawId, dbAdmin);

  if (!cached) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No cached summary' } });
    return;
  }

  res.json({ data: { content: cached.content, metadata: cached.transparencyMetadata ?? null } });
});

export default dashboardRouter;
