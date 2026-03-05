import { Router } from 'express';
import type { Request, Response } from 'express';
import { AUTH, ANALYTICS_EVENTS } from 'shared/constants';
import { chartFiltersSchema } from 'shared/schemas';
import type { DemoModeState } from 'shared/types';
import { verifyAccessToken } from '../services/auth/tokenService.js';
import { chartsQueries, datasetsQueries, orgsQueries } from '../db/queries/index.js';
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
  };

  const result = chartFiltersSchema.safeParse(raw);
  if (!result.success) return { dateFrom: undefined, dateTo: undefined, categories: undefined };

  return {
    dateFrom: result.data.dateFrom,
    dateTo: result.data.dateTo,
    categories: result.data.categories,
  };
}

function hasFilters(filters: ReturnType<typeof parseFilterParams>): boolean {
  return !!(filters.dateFrom || filters.dateTo || filters.categories);
}

// public — unauthenticated visitors get seed org
dashboardRouter.get('/dashboard/charts', async (req: Request, res: Response) => {
  let orgId: number;
  let orgName: string;
  let isDemo = true;
  let demoState: DemoModeState = 'seed_only';
  let authedUser: { userId: number; orgId: number } | null = null;

  const token = req.cookies?.[AUTH.COOKIE_NAMES.ACCESS_TOKEN];

  if (token) {
    try {
      const payload = await verifyAccessToken(token);
      orgId = payload.org_id;
      authedUser = { userId: Number(payload.sub), orgId: payload.org_id };

      const org = await orgsQueries.findOrgById(orgId);
      orgName = org?.name ?? 'Your Organization';
      isDemo = false;
      try {
        demoState = await datasetsQueries.getUserOrgDemoState(orgId);
      } catch {
        demoState = 'empty';
      }
    } catch {
      // expired or invalid token — fall through to seed org
      orgId = await orgsQueries.getSeedOrgId();
      orgName = 'Sunrise Cafe';
    }
  } else {
    orgId = await orgsQueries.getSeedOrgId();
    orgName = 'Sunrise Cafe';
  }

  const filters = parseFilterParams(req.query);
  const chartData = await chartsQueries.getChartData(orgId, hasFilters(filters) ? filters : undefined);

  if (authedUser) {
    trackEvent(authedUser.orgId, authedUser.userId, ANALYTICS_EVENTS.DASHBOARD_VIEWED, {
      isDemo,
      chartCount: chartData.revenueTrend.length + chartData.expenseBreakdown.length,
    });

    if (hasFilters(filters)) {
      trackEvent(authedUser.orgId, authedUser.userId, ANALYTICS_EVENTS.CHART_FILTERED, {
        dateFrom: filters.dateFrom?.toISOString(),
        dateTo: filters.dateTo?.toISOString(),
        categories: filters.categories,
      });
    }
  }

  logger.info({ orgId, isDemo, filtered: hasFilters(filters) }, 'Dashboard charts served');

  res.json({
    data: {
      ...chartData,
      orgName,
      isDemo,
      demoState,
    },
  });
});

export default dashboardRouter;
