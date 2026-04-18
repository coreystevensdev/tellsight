import { Router } from 'express';
import type { Response } from 'express';
import { ANALYTICS_EVENTS, AI_MONTHLY_QUOTA } from 'shared/constants';

import type { SubscriptionTier } from 'shared/types';

import { requireUser } from '../lib/requireUser.js';
import { subscriptionGate } from '../middleware/subscriptionGate.js';
import { rateLimitAi } from '../middleware/rateLimiter.js';
import { aiSummariesQueries, analyticsEventsQueries, dataRowsQueries, orgsQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { streamToSSE } from '../services/aiInterpretation/streamHandler.js';
import { withRlsContext } from '../lib/rls.js';
import { ValidationError, QuotaExceededError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';
import { aiSummaryTotal, aiTokensUsed } from '../lib/metrics.js';

const aiSummaryRouter = Router();

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

  // quota gate — cache hits don't count, so this runs after the cache check
  const quota = AI_MONTHLY_QUOTA[tier] ?? AI_MONTHLY_QUOTA.free;
  const usageCount = await analyticsEventsQueries.getMonthlyAiUsageCount(orgId);
  if (usageCount >= quota) {
    throw new QuotaExceededError(
      `Monthly AI summary limit reached (${quota}). ${tier === 'free' ? 'Upgrade to Pro for 100 summaries/month.' : 'Quota resets next month.'}`,
      { tier, quota, used: usageCount },
    );
  }

  await new Promise<void>((resolve, reject) => {
    rateLimitAi(req, res, (err?: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });

  if (res.headersSent) return;

  // streaming runs outside the RLS transaction (holding a tx for 3-15s would starve the pool).
  // dbAdmin bypasses RLS — safe because the route is auth-gated and orgId comes from the JWT.
  const [streamStart, datasetSize, profile] = await Promise.all([
    Promise.resolve(Date.now()),
    dataRowsQueries.getRowCount(orgId, rawId, dbAdmin),
    orgsQueries.getBusinessProfile(orgId),
  ]);
  const outcome = await streamToSSE(req, res, orgId, rawId, tier, dbAdmin, profile);

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
