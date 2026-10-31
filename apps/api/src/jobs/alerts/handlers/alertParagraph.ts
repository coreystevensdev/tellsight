import type { AlertRuleKind } from 'shared/schemas';
import type { BusinessProfile } from 'shared/types';

import { aiSummariesQueries, orgsQueries } from '../../../db/queries/index.js';
import { logger } from '../../../lib/logger.js';
import { generateInterpretation } from '../../../services/aiInterpretation/claudeClient.js';
import {
  assemblePrompt,
  StatType,
  stripInvalidCiteRefs,
  transparencyMetadataSchema,
  validateCiteRefs,
} from '../../../services/curation/index.js';
import { RULE_KIND_LABELS } from '../ruleKindLabels.js';
import type { SendJobData } from '../queue.js';

const ALERT_PROMPT_VERSION = 'v1-alert';

function fallbackParagraph(ruleKind: AlertRuleKind, currentValue: number): string {
  return `${RULE_KIND_LABELS[ruleKind]}. Current value: ${currentValue.toFixed(2)}.`;
}

// evaluateCashBurn's trigger (latest month's expenses vs. the prior average)
// is a separate calculation from CashFlowStat's own direction/monthsBurning
// fields (derived from trailing median net), so a spike can fire while those
// fields still read "surplus"/0 months burning. Left unexplained, the AI
// paragraph would narrate the contradiction as if it were an error rather
// than two true, differently-scoped signals -- DW-41.
function cashBurnSpikeCaveat(ruleKind: AlertRuleKind, insight: SendJobData['firedInsight']): string {
  if (ruleKind !== 'cash_burn_spikes' || insight.stat.statType !== StatType.CashFlow) return '';
  const { direction, monthsBurning } = insight.stat.details;
  if (direction !== 'surplus' && monthsBurning > 0) return '';
  return (
    'Context: this alert fired because of a sharp jump in this month\'s expenses specifically, ' +
    'not a change in the multi-month cash flow trend, which still looks healthy. Frame the ' +
    "interpretation around this month's spike, not the broader trend."
  );
}

/**
 * Cache-first alert paragraph: a hit returns the stored content, a miss
 * calls Claude with the fired insight and caches the result. Any failure
 * along this path (DB, Claude, validation) degrades to the deterministic
 * RULE_KIND_LABELS sentence rather than failing the send, per the epic's
 * "interpretation degrades, delivery doesn't" posture.
 */
export async function resolveAlertParagraph(data: SendJobData): Promise<string> {
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
      new Date(),
      cashBurnSpikeCaveat(data.ruleKind, data.firedInsight),
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
    if (citeReport.invalidRefs.length > 0) {
      logger.warn(
        {
          orgId: data.orgId,
          datasetId: data.datasetId,
          invalidRefs: citeReport.invalidRefs,
          promptVersion: ALERT_PROMPT_VERSION,
        },
        'AI summary referenced unknown stat instance IDs, stripped before cache',
      );
    }

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
