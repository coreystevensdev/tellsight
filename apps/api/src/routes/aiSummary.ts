import { Router } from 'express';
import type { Response } from 'express';

import { z } from 'zod';

import { ANALYTICS_EVENTS, AI_MONTHLY_QUOTA } from 'shared/constants';
import type { SubscriptionTier, SourceRow } from 'shared/types';
import { requireUser } from '../lib/requireUser.js';
import { subscriptionGate } from '../middleware/subscriptionGate.js';
import { rateLimitAi, rateLimitDashboardCompute } from '../middleware/rateLimiter.js';
import { aiSummariesQueries, analyticsEventsQueries, dataRowsQueries, orgsQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { streamToSSE } from '../services/aiInterpretation/streamHandler.js';
import { withRlsContext } from '../lib/rls.js';
import { ValidationError, QuotaExceededError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';
import { aiSummaryTotal, aiTokensUsed, statCitationTotal } from '../lib/metrics.js';
import { buildStatDetail } from '../services/curation/statDetail.js';
import { resolveSourceRows } from '../services/curation/sourceRows.js';
import { fetchAndResolveStat } from '../services/curation/citation.js';

const sourceRowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const aiSummaryRouter = Router();

// Wraps fetchAndResolveStat (citation.ts) with the 404-on-miss response;
// both call sites below share the fetch-and-resolve logic and just need
// `if (!resolution) return`.
async function resolveCitedStatOrNotFound(
  res: Response,
  orgId: number,
  isAdmin: boolean,
  rawId: number,
  statId: string,
) {
  const resolution = await fetchAndResolveStat(orgId, isAdmin, rawId, statId);
  if (!resolution) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'This citation is no longer available' },
    });
    return null;
  }

  return resolution;
}

aiSummaryRouter.get('/:datasetId/latest', async (req, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const rawId = Number(req.params.datasetId);

  if (!Number.isInteger(rawId) || rawId <= 0) {
    throw new ValidationError('Invalid datasetId');
  }

  const latest = await withRlsContext(orgId, user.isAdmin, (tx) =>
    aiSummariesQueries.getLatestSummary(orgId, rawId, tx),
  );

  if (!latest) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'No summary exists for this dataset yet' },
    });
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

// Reconciliation endpoint behind a <cite> tag, recomputes the dataset's
// stats (same pipeline as summary generation) and resolves one instance by
// id. A stale id (valid when the summary was cached, expired since, e.g.
// cashAsOfDate aged past 180 days) 404s the same as an id that never
// existed, the route has no way to tell the two apart without extra state.
aiSummaryRouter.get('/:datasetId/stats/:statId', rateLimitDashboardCompute, async (req, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const rawId = Number(req.params.datasetId);
  const statId = req.params.statId;

  if (!Number.isInteger(rawId) || rawId <= 0) {
    throw new ValidationError('Invalid datasetId');
  }
  if (typeof statId !== 'string' || statId.length === 0) {
    throw new ValidationError('Invalid statId');
  }

  const resolution = await resolveCitedStatOrNotFound(res, orgId, user.isAdmin, rawId, statId);
  if (!resolution) {
    statCitationTotal.inc({ outcome: 'not_found' });
    return;
  }
  const { stat } = resolution;
  const detail = buildStatDetail(stat);
  statCitationTotal.inc({ outcome: 'ok' });

  logger.info({ orgId, datasetId: rawId, statType: stat.statType }, 'stat citation resolved');
  res.json({
    data: {
      statType: stat.statType,
      value: stat.value,
      detail,
    },
  });
});

// Row-level evidence behind a resolved stat, paginated in memory: the row
// set is already fetched in full by resolveCitedStatOrNotFound, so a second
// DB round trip just to paginate would be wasted work. The filtered result
// is bounded per category/window for most stat types; an overall-scope
// total/average is the one case that legitimately spans every row, still
// capped per response by `limit`/`offset` like any other citation.
aiSummaryRouter.get('/:datasetId/stats/:statId/rows', rateLimitDashboardCompute, async (req, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const rawId = Number(req.params.datasetId);
  const statId = req.params.statId;

  if (!Number.isInteger(rawId) || rawId <= 0) {
    throw new ValidationError('Invalid datasetId');
  }
  if (typeof statId !== 'string' || statId.length === 0) {
    throw new ValidationError('Invalid statId');
  }

  const parsedQuery = sourceRowsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    throw new ValidationError('Invalid query parameters', parsedQuery.error.issues);
  }
  const { limit, offset } = parsedQuery.data;

  const resolution = await resolveCitedStatOrNotFound(res, orgId, user.isAdmin, rawId, statId);
  if (!resolution) return;
  const { rows, stat } = resolution;

  const matched = resolveSourceRows(rows, stat);
  const total = matched.length;
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit) || 1;
  const data: SourceRow[] = matched.slice(offset, offset + limit).map((r) => ({
    id: r.id,
    date: r.date,
    category: r.category,
    parentCategory: r.parentCategory,
    amount: r.amount,
    label: r.label,
  }));

  logger.info({ orgId, datasetId: rawId, statType: stat.statType, total }, 'stat source rows resolved');
  res.json({
    data,
    meta: { total, pagination: { page, pageSize: limit, totalPages } },
  });
});

aiSummaryRouter.get('/:datasetId', subscriptionGate, async (req, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const userId = Number(user.sub);
  const rawId = Number(req.params.datasetId);
  const tier: SubscriptionTier = req.subscriptionTier ?? 'free';

  if (!Number.isInteger(rawId) || rawId <= 0) {
    throw new ValidationError('Invalid datasetId');
  }

  trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_REQUESTED, { datasetId: rawId });

  const cached = await withRlsContext(orgId, user.isAdmin, (tx) =>
    aiSummariesQueries.getCachedSummary(orgId, rawId, tx),
  );
  if (cached) {
    logger.info({ orgId, datasetId: rawId }, 'AI summary cache hit');
    aiSummaryTotal.inc({ tier, cache_hit: 'true', outcome: 'ok' });
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_COMPLETED, {
      datasetId: rawId,
      tier,
      cacheHit: true,
    });
    res.json({
      data: {
        content: cached.content,
        metadata: cached.transparencyMetadata,
        fromCache: true,
      },
    });
    return;
  }

  // quota gate, cache hits don't count, so this runs after the cache check
  const quota = AI_MONTHLY_QUOTA[tier] ?? AI_MONTHLY_QUOTA.free;
  const usageCount = await analyticsEventsQueries.getMonthlyAiUsageCount(orgId);
  if (usageCount >= quota) {
    throw new QuotaExceededError(
      `Monthly AI summary limit reached (${quota}). ${tier === 'free' ? 'Upgrade to Pro for 100 summaries/month.' : 'Quota resets next month.'}`,
      { tier, quota, used: usageCount },
    );
  }

  await new Promise<void>((resolve, reject) => {
    // rateLimitAi fails open on unexpected errors (calls next()) and on an
    // actual 429 responds via res directly instead of calling next -- this
    // callback never fires on that path. res.once('finish'/'close') below
    // is the fallback that unblocks this promise for the 429 and
    // client-disconnect branches.
    rateLimitAi(req, res, (err?: unknown) => {
      if (err) reject(err);
      else resolve();
    });
    res.once('finish', resolve);
    res.once('close', resolve);
  });

  if (res.headersSent) return;

  // streaming runs outside the RLS transaction (holding a tx for 3-15s would starve the pool).
  // dbAdmin bypasses RLS, safe because the route is auth-gated and orgId comes from the JWT.
  const [streamStart, datasetSize, profile] = await Promise.all([
    Promise.resolve(Date.now()),
    dataRowsQueries.getRowCount(orgId, rawId, dbAdmin),
    orgsQueries.getBusinessProfile(orgId),
  ]);
  const outcome = await streamToSSE(res, orgId, rawId, userId, tier, dbAdmin, profile);

  aiSummaryTotal.inc({ tier, cache_hit: 'false', outcome: outcome.ok ? 'ok' : 'error' });
  if (outcome.ok) {
    if (outcome.usage) {
      aiTokensUsed.inc({ tier, direction: 'input' }, outcome.usage.inputTokens);
      aiTokensUsed.inc({ tier, direction: 'output' }, outcome.usage.outputTokens);
    }
    trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_COMPLETED, {
      datasetId: rawId,
      tier,
      cacheHit: false,
      datasetSize,
      computationTimeMs: Date.now() - streamStart,
      ...(outcome.usage && {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      }),
    });
  }
});

export { aiSummaryRouter };
