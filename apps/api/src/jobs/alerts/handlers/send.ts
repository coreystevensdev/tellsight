import type { Job } from 'bullmq';
import type { AlertRuleKind } from 'shared/schemas';
import type { BusinessProfile } from 'shared/types';
import { buildAlertUtmParams } from 'shared/constants';

import { logger } from '../../../lib/logger.js';
import { env } from '../../../config.js';
import { Sentry } from '../../../lib/sentry.js';
import { sendEmail, EmailSendError } from '../../../services/email/index.js';
import { aiSummariesQueries, orgsQueries } from '../../../db/queries/index.js';
import {
  assemblePrompt,
  StatType,
  transparencyMetadataSchema,
  validateCiteRefs,
  stripInvalidCiteRefs,
} from '../../../services/curation/index.js';
import { generateInterpretation } from '../../../services/aiInterpretation/claudeClient.js';
import { getChartKindForRuleKind } from '../../../services/charting/chartKind.js';
import { renderChart } from '../../../services/charting/renderChart.js';
import type { ChartRenderInput } from '../../../services/charting/renderChart.js';
import { AlertEmail, buildAlertRecipientExplanation } from '../templates/alertEmail.js';
import { signMuteToken } from '../muteToken.js';
import { signAlertTrackingToken } from '../trackingToken.js';
import { RULE_KIND_LABELS, RULE_KIND_NOUN_LABELS } from '../ruleKindLabels.js';
import type { SendJobData } from '../queue.js';

const TEMPLATE_VERSION = 'alert-v1';
const ALERT_PROMPT_VERSION = 'v1-alert';

function buildDashboardUrl(
  data: Pick<SendJobData, 'datasetId' | 'ruleKind' | 'orgId' | 'userId' | 'ruleId' | 'fireId'>,
): string {
  const url = new URL('/dashboard', env.APP_URL);
  url.searchParams.set('datasetId', String(data.datasetId));
  for (const [key, value] of Object.entries(buildAlertUtmParams(data.ruleKind))) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set(
    't',
    signAlertTrackingToken({
      orgId: data.orgId,
      userId: data.userId,
      ruleId: data.ruleId,
      ruleKind: data.ruleKind,
      fireId: data.fireId,
    }),
  );
  return url.toString();
}

function buildMuteUrl(ruleId: number): string {
  const token = signMuteToken(ruleId);
  return new URL(`/mute/alert-rule/${encodeURIComponent(token)}`, env.APP_URL).toString();
}

// Same URL-only one-click shape as digest's buildListUnsubscribeHeaders
// (RFC 8058, no mailto: half): we don't operate a receiving inbox.
function buildListUnsubscribeHeaders(
  muteUrl: string,
): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } {
  return {
    'List-Unsubscribe': `<${muteUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function fallbackParagraph(ruleKind: AlertRuleKind, currentValue: number): string {
  return `${RULE_KIND_LABELS[ruleKind]}. Current value: ${currentValue.toFixed(2)}.`;
}

/**
 * Cache-first alert paragraph: a hit returns the stored content, a miss
 * calls Claude with the fired insight and caches the result. Any failure
 * along this path (DB, Claude, validation) degrades to the deterministic
 * RULE_KIND_LABELS sentence rather than failing the send, per the epic's
 * "interpretation degrades, delivery doesn't" posture.
 */
async function resolveAlertParagraph(data: SendJobData): Promise<string> {
  try {
    const cached = await aiSummariesQueries.getCachedAlertSummary(data.orgId, data.datasetId, data.fireId);
    if (cached) return cached.content;

    const org = await orgsQueries.findOrgById(data.orgId);
    const businessProfile = (org?.businessProfile ?? null) as BusinessProfile | null;

    const { system, user, metadata } = assemblePrompt(
      [data.firedInsight],
      data.datasetId,
      ALERT_PROMPT_VERSION,
      businessProfile,
    );
    const validatedMetadata = transparencyMetadataSchema.parse(metadata);
    const content = await generateInterpretation({ system, user });

    // Tier 2b, same defense-in-depth as the digest path: v1-alert never asks
    // for a <cite> tag, but formatStat appends the [cite: <id>] suffix
    // regardless, so a hallucinated citation is still possible here.
    const citeReport = validateCiteRefs(content, [data.firedInsight.stat], data.datasetId);
    const cleaned = citeReport.invalidRefs.length > 0
      ? stripInvalidCiteRefs(content, citeReport.invalidRefs)
      : content;

    await aiSummariesQueries.storeSummary({
      orgId: data.orgId,
      datasetId: data.datasetId,
      content: cleaned,
      metadata: validatedMetadata,
      promptVersion: ALERT_PROMPT_VERSION,
      audience: 'alert',
      fireId: data.fireId,
    });

    return cleaned;
  } catch (err) {
    logger.warn(
      { correlationId: data.correlationId, orgId: data.orgId, ruleId: data.ruleId, err },
      'Alert LLM paragraph failed, falling back to deterministic sentence',
    );
    return fallbackParagraph(data.ruleKind, data.currentValue);
  }
}

// Maps a fired insight onto the chart component's expected input shape.
// Returns null both when the rule kind has no chart mapping and when the
// insight's actual statType doesn't match what the chart kind expects (a
// defensive mismatch that shouldn't happen given evaluateOrg's selection,
// but a bad chart is worse than no chart).
function buildChartInput(
  ruleKind: AlertRuleKind,
  insight: SendJobData['firedInsight'],
  logFields: Record<string, unknown>,
): ChartRenderInput | null {
  const chartKind = getChartKindForRuleKind(ruleKind);
  if (!chartKind) return null;

  const mismatch = (): null => {
    logger.warn(
      { ...logFields, chartKind, actualStatType: insight.stat.statType },
      'Fired insight statType does not match the expected chart kind, sending text-only',
    );
    return null;
  };

  switch (chartKind) {
    case 'runway':
      if (insight.stat.statType !== StatType.Runway) return mismatch();
      return {
        chartKind: 'runway',
        data: {
          cashOnHand: insight.stat.details.cashOnHand,
          monthlyNet: insight.stat.details.monthlyNet,
          runwayMonths: insight.stat.details.runwayMonths,
        },
      };
    case 'cash-flow':
      if (insight.stat.statType !== StatType.CashFlow) return mismatch();
      return { chartKind: 'cash-flow', data: { recentMonths: insight.stat.details.recentMonths } };
    case 'margin':
      if (insight.stat.statType !== StatType.MarginTrend) return mismatch();
      return {
        chartKind: 'margin',
        data: {
          recentMarginPercent: insight.stat.details.recentMarginPercent,
          priorMarginPercent: insight.stat.details.priorMarginPercent,
          direction: insight.stat.details.direction,
        },
      };
  }
}

export async function handleSendJob(job: Job): Promise<void> {
  const data = job.data as SendJobData;
  const { orgId, userId, userEmail, ruleId, ruleKind, fireId, trigger, correlationId } = data;
  const start = Date.now();
  const chartKind = getChartKindForRuleKind(ruleKind);

  await Sentry.withScope(async (scope) => {
    scope.setTag('org_id', String(orgId));
    scope.setTag('rule_id', String(ruleId));
    scope.setTag('rule_kind', ruleKind);
    scope.setTag('template_version', TEMPLATE_VERSION);
    if (chartKind) scope.setTag('chart_kind', chartKind);

    const dashboardUrl = buildDashboardUrl(data);
    const muteUrl = buildMuteUrl(ruleId);
    const headers = buildListUnsubscribeHeaders(muteUrl);

    const renderStart = Date.now();
    const chartInput = buildChartInput(ruleKind, data.firedInsight, { correlationId, orgId, ruleId });
    const chartPng = chartInput
      ? await renderChart(chartInput, { correlationId, orgId, ruleId })
      : null;
    const renderingDurationMs = Date.now() - renderStart;

    const paragraph = await resolveAlertParagraph(data);
    const headline = RULE_KIND_LABELS[ruleKind];
    const chartContentId = chartPng ? `chart-${fireId}` : undefined;

    const template = AlertEmail({
      orgName: data.orgName,
      headline,
      paragraph,
      dashboardUrl,
      muteUrl,
      mailingAddress: env.EMAIL_MAILING_ADDRESS,
      companyName: env.EMAIL_FROM_NAME,
      ruleKindLabel: RULE_KIND_NOUN_LABELS[ruleKind],
      chartContentId,
    });

    try {
      const result = await sendEmail({
        to: userEmail,
        subject: headline,
        react: template,
        tags: { template: TEMPLATE_VERSION, org_id: String(orgId), rule_id: String(ruleId) },
        headers,
        correlationId,
        ...(chartPng && chartContentId
          ? { attachments: [{ filename: 'chart.png', content: chartPng, contentId: chartContentId }] }
          : {}),
      });

      logger.info(
        {
          correlationId,
          orgId,
          userId,
          ruleId,
          fireId,
          trigger,
          templateVersion: TEMPLATE_VERSION,
          renderingDurationMs,
          outcome: 'sent',
          providerMessageId: result.providerMessageId,
          durationMs: Date.now() - start,
          canSpamElements: {
            mailingAddress: env.EMAIL_MAILING_ADDRESS,
            muteUrl,
            recipientExplanation: buildAlertRecipientExplanation(RULE_KIND_NOUN_LABELS[ruleKind], data.orgName),
            companyName: env.EMAIL_FROM_NAME,
          },
        },
        'Alert send complete',
      );
    } catch (err) {
      // Only a non-retryable EmailSendError (bad address, provider rejected
      // the content) is a true terminal failure. Anything else -- a bug here,
      // an unwrapped provider exception, a transient error that wasn't
      // classified -- must still surface as a job failure so BullMQ retries
      // it instead of silently dropping the alert.
      const isTerminal = err instanceof EmailSendError && !err.retryable;
      if (!isTerminal) {
        logger.warn(
          {
            correlationId,
            orgId,
            userId,
            ruleId,
            fireId,
            trigger,
            templateVersion: TEMPLATE_VERSION,
            renderingDurationMs,
            outcome: 'error',
            durationMs: Date.now() - start,
            err: err instanceof Error ? err.message : String(err),
            providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : undefined,
          },
          'Alert send failure, BullMQ will retry',
        );
        throw err;
      }

      logger.error(
        {
          correlationId,
          orgId,
          userId,
          ruleId,
          fireId,
          trigger,
          templateVersion: TEMPLATE_VERSION,
          renderingDurationMs,
          outcome: 'error',
          err,
          providerStatusCode: err instanceof EmailSendError ? err.providerStatusCode : undefined,
          durationMs: Date.now() - start,
        },
        'Alert send terminal failure',
      );
    }
  });
}
