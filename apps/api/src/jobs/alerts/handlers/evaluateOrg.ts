import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';
import { ANALYTICS_EVENTS } from 'shared/constants';
import type { AnalyticsEventName } from 'shared/constants';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { Sentry } from '../../../lib/sentry.js';
import {
  subscriptionsQueries,
  orgsQueries,
  alertRulesQueries,
  alertRuleFiresQueries,
  dataRowsQueries,
  userOrgsQueries,
  usersQueries,
  analyticsEventsQueries,
} from '../../../db/queries/index.js';
import { runCurationPipeline, StatType } from '../../../services/curation/index.js';
import type { ScoredInsight } from '../../../services/curation/index.js';
import { cashFlowForAlerting } from '../../../services/curation/computation.js';
import { scoreInsights } from '../../../services/curation/scoring.js';
import type { AlertRuleRow } from '../../../db/queries/alertRules.js';
import * as runwayBands from '../bands/runwayBands.js';
import * as marginBands from '../bands/marginBands.js';
import * as cashBurnBands from '../bands/cashBurnBands.js';
import * as breakevenBands from '../bands/breakevenBands.js';
import * as anomalyBands from '../bands/anomalyBands.js';
import {
  getSendQueue,
  JOB_PREFIX_SEND,
  evaluateOrgJobDataSchema,
  type SendJobData,
} from '../queue.js';

const ON_UPLOAD_KINDS = new Set(['runway_runs_short', 'cash_burn_spikes']);
const MIN_ON_UPLOAD_HISTORY_DAYS = 30;
const MIN_ON_UPLOAD_HISTORY_DISTINCT_DAYS = 20;
const DEDUP_WINDOW_MS = 7 * 86_400_000;
const ORG_QUOTA_MAX = 3;

const SEND_JOB_ATTEMPTS = 3;
const SEND_JOB_BACKOFF_MS = 30_000;

type Outcome = 'fired' | 'suppressed_dedup' | 'suppressed_quota' | 'suppressed_below_threshold' | 'error';

interface RuleEvaluation {
  currentValue: number;
  band: number | null;
  insight: ScoredInsight;
}

function evaluateRunway(insights: ScoredInsight[], threshold: number): RuleEvaluation | null {
  const insight = insights.find((i) => i.stat.statType === StatType.Runway);
  if (!insight || insight.stat.statType !== StatType.Runway) return null;
  const currentValue = insight.stat.details.runwayMonths;
  return { currentValue, band: runwayBands.getBand(currentValue, threshold), insight };
}

function evaluateMargin(insights: ScoredInsight[], threshold: number): RuleEvaluation | null {
  const insight = insights.find((i) => i.stat.statType === StatType.MarginTrend);
  if (!insight || insight.stat.statType !== StatType.MarginTrend) return null;
  // Positive when margin has contracted; negative (expanding margin) never
  // clears a positive threshold, so no separate direction check is needed.
  const currentValue = insight.stat.details.priorMarginPercent - insight.stat.details.recentMarginPercent;
  return { currentValue, band: marginBands.getBand(currentValue, threshold), insight };
}

function evaluateCashBurn(
  cashFlowInsight: ScoredInsight | null,
  threshold: number,
): RuleEvaluation | null {
  if (!cashFlowInsight || cashFlowInsight.stat.statType !== StatType.CashFlow) return null;

  const months = cashFlowInsight.stat.details.recentMonths;
  if (months.length < 2) return { currentValue: 0, band: null, insight: cashFlowInsight };

  const latest = months[months.length - 1]!;
  const priorMonths = months.slice(0, -1);
  const priorAvgExpenses = priorMonths.reduce((sum, m) => sum + m.expenses, 0) / priorMonths.length;
  // A zero prior average is a divide-by-zero guard, not "no change": going from
  // $0 to any real spend is the worst possible spike. threshold * 3 clears the
  // top band (>= threshold * 2) without an Infinity/NaN sentinel, which would
  // silently become null crossing BullMQ's JSON-serialized job boundary.
  const currentValue =
    priorAvgExpenses > 0
      ? ((latest.expenses - priorAvgExpenses) / priorAvgExpenses) * 100
      : latest.expenses > 0
        ? threshold * 3
        : 0;

  return { currentValue, band: cashBurnBands.getBand(currentValue, threshold), insight: cashFlowInsight };
}

function evaluateBreakeven(insights: ScoredInsight[], threshold: number): RuleEvaluation | null {
  const insight = insights.find((i) => i.stat.statType === StatType.BreakEven);
  if (!insight || insight.stat.statType !== StatType.BreakEven) return null;

  const { gap, breakEvenRevenue } = insight.stat.details;
  // Same zero-denominator guard as evaluateCashBurn: a $0 break-even revenue
  // with a real positive gap is the worst case, not a no-op.
  const currentValue =
    breakEvenRevenue > 0 ? (gap / breakEvenRevenue) * 100 : gap > 0 ? threshold * 3 : 0;
  return { currentValue, band: breakevenBands.getBand(currentValue, threshold), insight };
}

function evaluateAnomaly(
  insights: ScoredInsight[],
  threshold: 'low' | 'moderate' | 'high',
): RuleEvaluation | null {
  const anomalyInsights = insights.filter((i) => i.stat.statType === StatType.Anomaly);
  if (anomalyInsights.length === 0) return null;

  // Multiple anomalies can surface in one pass (one per category); the most
  // statistically extreme one drives the rule's confidence tier.
  const mostSevere = anomalyInsights.reduce((max, i) => {
    if (i.stat.statType !== StatType.Anomaly || max.stat.statType !== StatType.Anomaly) return max;
    return Math.abs(i.stat.details.zScore) > Math.abs(max.stat.details.zScore) ? i : max;
  });
  if (mostSevere.stat.statType !== StatType.Anomaly) return null;

  const currentValue = anomalyBands.confidenceOrdinalFromZScore(mostSevere.stat.details.zScore);
  return { currentValue, band: anomalyBands.getBand(currentValue, threshold), insight: mostSevere };
}

function evaluateRule(
  insights: ScoredInsight[],
  cashFlowForAlertingInsight: ScoredInsight | null,
  rule: AlertRuleRow,
): RuleEvaluation | null {
  switch (rule.kind) {
    case 'runway_runs_short':
      return evaluateRunway(insights, (rule.threshold as { months: number }).months);
    case 'margin_drops':
      return evaluateMargin(insights, (rule.threshold as { percent: number }).percent);
    case 'cash_burn_spikes':
      return evaluateCashBurn(cashFlowForAlertingInsight, (rule.threshold as { percent: number }).percent);
    case 'breakeven_gap_widens':
      return evaluateBreakeven(insights, (rule.threshold as { percent: number }).percent);
    case 'anomaly_fires':
      return evaluateAnomaly(insights, (rule.threshold as { confidence: 'low' | 'moderate' | 'high' }).confidence);
    default: {
      const exhaustive: never = rule.kind;
      logger.error({ ruleId: rule.id, ruleKind: exhaustive }, 'Unknown alert rule kind, no evaluator wired');
      return null;
    }
  }
}

function sendJobName(fireId: number): string {
  return `${JOB_PREFIX_SEND}-${fireId}`;
}

// orgId-only analytics: a fire isn't attributable to a single acting user
// (trackEvent requires one), so this goes straight through recordEvent with
// userId null, same shape as trackEventSystem but keeping the org association.
function recordAlertEvent(
  orgId: number,
  eventName: AnalyticsEventName,
  metadata: Record<string, unknown>,
): void {
  analyticsEventsQueries.recordEvent(orgId, null, eventName, metadata, dbAdmin).catch((err) => {
    logger.error({ err, orgId, eventName }, 'Failed to record alerts analytics event');
  });
}

function logOutcome(
  correlationId: string,
  orgId: number,
  rule: AlertRuleRow,
  trigger: string,
  outcome: Outcome,
  extra: Record<string, unknown> = {},
): void {
  logger.info(
    { correlationId, orgId, ruleId: rule.id, ruleKind: rule.kind, trigger, outcome, ...extra },
    'Alert rule evaluated',
  );
}

/**
 * Per-org evaluator. Re-verifies Pro tier and re-fetches enabled rules itself
 * regardless of trigger: findEligibleOrgs (cron) is a courtesy pre-filter,
 * not the sole gate, since an org can downgrade between paging and
 * processing.
 */
export async function handleEvaluateOrgJob(job: Job): Promise<void> {
  const parsed = evaluateOrgJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.warn(
      {
        correlationId: typeof job.data?.correlationId === 'string' ? job.data.correlationId : undefined,
        jobId: job.id,
        issues: parsed.error.issues,
      },
      'invalid job payload, skipping',
    );
    return;
  }

  const { orgId, trigger, correlationId } = parsed.data;
  const start = Date.now();

  const tier = await subscriptionsQueries.getActiveTier(orgId, dbAdmin);
  if (tier !== 'pro') {
    logger.info(
      { correlationId, orgId, trigger, outcome: 'skipped', durationMs: Date.now() - start },
      'Alert evaluation skipped: org is not on Pro tier',
    );
    return;
  }

  // Always re-fetched, never trusted from job.data: an org can swap its
  // active dataset between the job being enqueued and this worker picking it
  // up, same re-verification reasoning as the Pro-tier check above.
  const datasetId = await orgsQueries.getActiveDatasetId(orgId, dbAdmin);
  if (datasetId === null || datasetId === undefined) {
    logger.info(
      { correlationId, orgId, trigger, outcome: 'skipped', durationMs: Date.now() - start },
      'Alert evaluation skipped: org has no active dataset',
    );
    return;
  }

  let rules = await alertRulesQueries.getEnabledByOrgIdsForEvaluation([orgId], dbAdmin);
  if (rules.length === 0) {
    logger.info(
      { correlationId, orgId, datasetId, trigger, outcome: 'skipped', durationMs: Date.now() - start },
      'Alert evaluation skipped: no enabled rules',
    );
    return;
  }

  if (trigger === 'on-upload') {
    rules = rules.filter((r) => ON_UPLOAD_KINDS.has(r.kind));
    if (rules.length === 0) return;

    const range = await dataRowsQueries.getDateRange(orgId, datasetId, dbAdmin);
    const spanDays = range ? (range.latest.getTime() - range.earliest.getTime()) / 86_400_000 : 0;
    // Span alone passes a two-row dataset 31 days apart. distinctDays catches
    // that: data_rows is one row per (date, category), so it's the density
    // signal span can't provide on its own.
    const distinctDays = range ? await dataRowsQueries.countDistinctDates(orgId, datasetId, dbAdmin) : 0;
    if (spanDays < MIN_ON_UPLOAD_HISTORY_DAYS || distinctDays < MIN_ON_UPLOAD_HISTORY_DISTINCT_DAYS) {
      for (const rule of rules) {
        logOutcome(correlationId, orgId, rule, trigger, 'suppressed_below_threshold', { spanDays, distinctDays });
      }
      return;
    }
  }

  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    logger.warn(
      { correlationId, orgId, trigger, outcome: 'skipped', durationMs: Date.now() - start },
      'Alert evaluation skipped: org row missing',
    );
    return;
  }

  const businessProfile = (org.businessProfile ?? null) as BusinessProfile | null;
  const financials = businessProfile
    ? {
        cashOnHand: businessProfile.cashOnHand,
        cashAsOfDate: businessProfile.cashAsOfDate,
        businessStartedDate: businessProfile.businessStartedDate,
        monthlyFixedCosts: businessProfile.monthlyFixedCosts,
      }
    : null;

  // dbAdmin, not the default client: this runs from a cross-org worker with
  // no per-request RLS session, same reasoning as every other query call in
  // this handler.
  const insights = await runCurationPipeline(orgId, datasetId, dbAdmin, financials);

  // cash_burn_spikes reads a separate cash-flow signal from the one in
  // `insights`: the shared curation pipeline suppresses CashFlow for orgs
  // near break-even (the dashboard's near-zero band), but that's exactly the
  // population most likely to have a real spike worth alerting on. Gated
  // behind the rule check so orgs without cash_burn_spikes never pay for the
  // extra query.
  const cashFlowForAlertingInsight = rules.some((r) => r.kind === 'cash_burn_spikes')
    ? (scoreInsights(
        cashFlowForAlerting(await dataRowsQueries.getMonthlyBucketsByDataset(orgId, datasetId, dbAdmin)),
      )[0] ?? null)
    : null;

  let firedCount = 0;
  let suppressedCount = 0;

  for (const rule of rules) {
    await Sentry.withScope(async (scope) => {
      scope.setTag('org_id', String(orgId));
      scope.setTag('rule_id', String(rule.id));
      scope.setTag('rule_kind', rule.kind);

      const evaluation = evaluateRule(insights, cashFlowForAlertingInsight, rule);
      if (!evaluation || evaluation.band === null) {
        logOutcome(correlationId, orgId, rule, trigger, 'suppressed_below_threshold', {
          currentValue: evaluation?.currentValue ?? null,
        });
        suppressedCount++;
        return;
      }

      const { currentValue, band, insight: firedInsight } = evaluation;

      const latestFire = await alertRuleFiresQueries.getLatestByRuleId(rule.id, dbAdmin);
      const withinDedupWindow =
        latestFire && Date.now() - latestFire.firedAt.getTime() < DEDUP_WINDOW_MS;
      if (withinDedupWindow && latestFire!.band === band) {
        logOutcome(correlationId, orgId, rule, trigger, 'suppressed_dedup', { band, currentValue });
        suppressedCount++;
        return;
      }

      // Count-and-insert happens atomically inside createIfUnderQuota (advisory
      // lock + re-check), a plain count-then-insert here would let two
      // concurrent jobs for the same org both pass the check and blow the quota.
      const fire = await alertRuleFiresQueries.createIfUnderQuota(
        {
          orgId,
          ruleId: rule.id,
          ruleKind: rule.kind,
          trigger,
          thresholdValue: rule.threshold,
          currentValue,
          band,
        },
        ORG_QUOTA_MAX,
        dbAdmin,
      );
      if (!fire) {
        logOutcome(correlationId, orgId, rule, trigger, 'suppressed_quota', { band, currentValue });
        recordAlertEvent(orgId, ANALYTICS_EVENTS.ALERT_QUOTA_SUPPRESSED, {
          ruleId: rule.id,
          ruleKind: rule.kind,
          band,
        });
        suppressedCount++;
        return;
      }

      logOutcome(correlationId, orgId, rule, trigger, 'fired', { band, currentValue, fireId: fire.id });
      recordAlertEvent(orgId, ANALYTICS_EVENTS.ALERT_FIRED, { ruleId: rule.id, ruleKind: rule.kind, band });
      firedCount++;

      const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
      const owner = ownerId ? await usersQueries.findUserById(ownerId) : null;
      if (!owner) {
        logger.warn({ correlationId, orgId, ruleId: rule.id }, 'Alert fired but org has no owner to notify');
        return;
      }

      const data: SendJobData = {
        orgId,
        orgName: org.name,
        userId: owner.id,
        userEmail: owner.email,
        datasetId,
        ruleId: rule.id,
        ruleKind: rule.kind,
        fireId: fire.id,
        currentValue,
        firedInsight,
        trigger,
        correlationId,
      };

      // The fire row above is already committed, so a throw here can't be
      // recovered by a BullMQ retry: dedup would see that same fire on the
      // retry and suppress it, silently dropping the alert for good. Log and
      // capture to Sentry instead so it's visible, and keep evaluating the
      // rest of this org's rules.
      try {
        const jobId = sendJobName(fire.id);
        await getSendQueue().add(jobId, data, {
          jobId,
          attempts: SEND_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_MS },
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 30 * 86_400 },
        });
      } catch (err) {
        Sentry.captureException(err);
        logger.error(
          { correlationId, orgId, ruleId: rule.id, fireId: fire.id, err },
          'Alert fired but send job could not be enqueued',
        );
      }
    });
  }

  logger.info(
    {
      correlationId,
      orgId,
      datasetId,
      trigger,
      ruleCount: rules.length,
      firedCount,
      suppressedCount,
      durationMs: Date.now() - start,
    },
    'Alert evaluation complete',
  );
}
