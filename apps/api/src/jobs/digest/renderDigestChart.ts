import { ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { trackEventOrg } from '../../services/analytics/trackEvent.js';
import { getChartKindForPool, type ChartKind } from '../../services/charting/chartKind.js';
import { renderChart } from '../../services/charting/renderChart.js';
import type { ChartRenderInput } from '../../services/charting/renderChart.js';
import { StatType, type ScoredInsight } from '../../services/curation/types.js';

// Everything the chart needs lives behind this one module, the same shape
// loadDigestAgentFindings uses for the agent bullets. perOrg gains one import
// rather than five, and the digest's 30 test files do not pull jsdom, React,
// Resvg and sharp into their module graphs just to exercise a send.

// Generous against the real read window. digest-send retries three times at 30s
// exponential backoff, so the last plausible read is minutes after the write,
// not hours. The TTL is also the only bound on these keys' memory: redis:7-alpine
// declares no maxmemory, so nothing evicts them.
const CHART_TTL_SECONDS = 24 * 60 * 60;

/**
 * Read by digest-send in the next slice, so the format is a contract between
 * two stories. datasetId is in the key on purpose: a fresh upload mints a new
 * dataset, and that must not be able to read the previous one's chart.
 */
export function chartCacheKey(orgId: number, datasetId: number, weekStart: Date): string {
  return `digest:chart:${orgId}:${datasetId}:${weekStart.getTime()}`;
}

// getChartKindForPool returns the kind, not the entry, so the stat has to be
// found again here. Taking the highest score of that kind finds the same stat
// the selector picked, because the selector's winner was the maximum, and both
// use a strict `>` so an intra-kind tie resolves to the first seen in both.
function bestOfKind(pool: ScoredInsight[], statType: StatType): ScoredInsight | null {
  let best: ScoredInsight | null = null;
  for (const entry of pool) {
    if (entry.stat.statType !== statType) continue;
    if (!best || entry.score > best.score) best = entry;
  }
  return best;
}

function buildChartInput(pool: ScoredInsight[], kind: ChartKind): ChartRenderInput | null {
  switch (kind) {
    case 'runway': {
      const hit = bestOfKind(pool, StatType.Runway);
      if (hit?.stat.statType !== StatType.Runway) return null;
      const { cashOnHand, monthlyNet, runwayMonths } = hit.stat.details;
      return { chartKind: 'runway', data: { cashOnHand, monthlyNet, runwayMonths } };
    }
    case 'cash-flow': {
      const hit = bestOfKind(pool, StatType.CashFlow);
      if (hit?.stat.statType !== StatType.CashFlow) return null;
      // Passed through rather than projected: the details carry a `net` per
      // month that the chart type does not declare, and structural typing
      // accepts it. The alert path does the same, so both feed the component
      // identically.
      return { chartKind: 'cash-flow', data: { recentMonths: hit.stat.details.recentMonths } };
    }
    case 'margin': {
      const hit = bestOfKind(pool, StatType.MarginTrend);
      if (hit?.stat.statType !== StatType.MarginTrend) return null;
      const { recentMarginPercent, priorMarginPercent, direction } = hit.stat.details;
      return { chartKind: 'margin', data: { recentMarginPercent, priorMarginPercent, direction } };
    }
  }
}

interface RenderDigestChartInput {
  orgId: number;
  datasetId: number;
  weekStart: Date;
  scoredPool: ScoredInsight[];
  correlationId: string;
}

/**
 * Renders this week's chart once for the org and leaves it where the per-send
 * jobs can find it. Returns the kind drawn, or null when there was nothing to
 * draw or drawing failed.
 *
 * Null is an ordinary outcome, not an error: a week with no chartable stat and
 * a week whose render degraded both send text-only, which is CAP-4.
 */
export async function renderDigestChart({
  orgId,
  datasetId,
  weekStart,
  scoredPool,
  correlationId,
}: RenderDigestChartInput): Promise<ChartKind | null> {
  const kind = getChartKindForPool(scoredPool);
  if (!kind) {
    // The only outcome that used to leave no trace at all, which made "no
    // chartable stat this week" and "the render broke" indistinguishable after
    // the fact.
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_CHART_DEGRADED, { reason: 'no_chartable_stat' });
    return null;
  }

  const input = buildChartInput(scoredPool, kind);
  if (!input) {
    // The selector found the kind, so the stat is in the pool. Reaching here
    // means the two disagree, which is a bug rather than a quiet week.
    logger.warn({ correlationId, orgId, chartKind: kind }, 'Chart kind selected but its stat was not found');
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_CHART_DEGRADED, { chartKind: kind, reason: 'stat_not_found' });
    return null;
  }

  const rendered = await renderChart(input, { correlationId, orgId });
  if (!rendered) {
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_CHART_DEGRADED, { chartKind: kind, reason: 'render_failed' });
    return null;
  }
  const { png, queueWaitMs, renderMs } = rendered;

  try {
    await redis.set(chartCacheKey(orgId, datasetId, weekStart), png, 'EX', CHART_TTL_SECONDS);
  } catch (err) {
    // enableOfflineQueue is false, so this throws rather than queuing when
    // Redis is down. A picture is not worth failing the week's digest over.
    logger.warn({ correlationId, orgId, chartKind: kind, err }, 'Could not cache the digest chart, sending text-only');
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_CHART_DEGRADED, { chartKind: kind, reason: 'cache_write_failed' });
    return null;
  }

  logger.info({ correlationId, orgId, datasetId, chartKind: kind, bytes: png.length }, 'Digest chart cached');
  trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_CHART_RENDERED, {
    chartKind: kind,
    queueWaitMs,
    renderMs,
    bytes: png.length,
  });
  return kind;
}

/**
 * The per-send half of the handoff. A miss is the ordinary case rather than an
 * error: a retry hours after the write, a Redis restart (this instance runs RDB
 * snapshots with AOF off), and an org whose week had no chartable stat all land
 * here, and each sends text-only.
 */
export async function readDigestChart(
  orgId: number,
  datasetId: number,
  weekStart: Date,
): Promise<Buffer | null> {
  try {
    return await redis.getBuffer(chartCacheKey(orgId, datasetId, weekStart));
  } catch (err) {
    logger.warn({ orgId, datasetId, err }, 'Could not read the digest chart, sending text-only');
    return null;
  }
}
