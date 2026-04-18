import { ANALYTICS_EVENTS } from 'shared/constants';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { orgsQueries, subscriptionsQueries, userOrgsQueries } from '../../db/queries/index.js';
import { runCurationPipeline, assemblePrompt } from '../curation/index.js';
import { generateInterpretation } from '../aiInterpretation/claudeClient.js';
import { trackEvent } from '../analytics/trackEvent.js';
import { sendDigestEmail } from './resendClient.js';
import { renderProDigest, renderFreeTeaser } from './templates.js';
import { signUnsubscribeToken } from './unsubscribeToken.js';

const DIGEST_PROMPT_VERSION = 'v1-digest';

interface DigestResult {
  orgId: number;
  orgName: string;
  tier: 'pro' | 'free';
  emailsSent: number;
  emailsFailed: number;
}

export async function generateDigestForOrg(
  orgId: number,
  datasetId: number,
  businessProfile?: Record<string, unknown> | null,
): Promise<string> {
  const insights = await runCurationPipeline(orgId, datasetId);

  if (insights.length === 0) {
    return '- Not enough data to generate insights this week. Upload more transactions to get started.';
  }

  const { prompt } = assemblePrompt(insights, DIGEST_PROMPT_VERSION, businessProfile as never);
  return generateInterpretation(prompt);
}

export async function processAllDigests(): Promise<DigestResult[]> {
  const allOrgs = await orgsQueries.getAllOrgsWithActiveDataset();
  const results: DigestResult[] = [];

  logger.info({ orgCount: allOrgs.length }, 'Starting weekly digest batch');

  for (const org of allOrgs) {
    try {
      const tier = await subscriptionsQueries.getActiveTier(org.id);
      const allMembers = await userOrgsQueries.getOrgMembers(org.id);
      const members = allMembers.filter((m) => m.digestOptIn);

      if (members.length === 0) continue;

      const dashboardUrl = env.APP_URL;
      let emailsSent = 0;
      let emailsFailed = 0;

      if (tier === 'pro') {
        const summary = await generateDigestForOrg(
          org.id,
          org.activeDatasetId!,
          org.businessProfile as Record<string, unknown> | null,
        );

        for (const membership of members) {
          const unsubscribeUrl = `${dashboardUrl}/unsubscribe/digest/${signUnsubscribeToken(membership.user.id, org.id)}`;
          const ok = await sendDigestEmail({
            to: membership.user.email,
            subject: `${org.name} — Weekly insights`,
            html: renderProDigest({ orgName: org.name, summary, dashboardUrl, unsubscribeUrl }),
          });

          if (ok) {
            emailsSent++;
            await trackEvent(org.id, membership.user.id, ANALYTICS_EVENTS.DIGEST_SENT, {
              tier: 'pro',
            });
          } else {
            emailsFailed++;
            await trackEvent(org.id, membership.user.id, ANALYTICS_EVENTS.DIGEST_FAILED, {
              tier: 'pro',
            });
          }
        }
      } else {
        // free users get a teaser
        for (const membership of members) {
          const unsubscribeUrl = `${dashboardUrl}/unsubscribe/digest/${signUnsubscribeToken(membership.user.id, org.id)}`;
          const ok = await sendDigestEmail({
            to: membership.user.email,
            subject: `${org.name} — Your weekly update is ready`,
            html: renderFreeTeaser({ orgName: org.name, dashboardUrl, unsubscribeUrl }),
          });

          if (ok) {
            emailsSent++;
            await trackEvent(org.id, membership.user.id, ANALYTICS_EVENTS.DIGEST_TEASER_SENT, {
              tier: 'free',
            });
          } else {
            emailsFailed++;
          }
        }
      }

      results.push({ orgId: org.id, orgName: org.name, tier, emailsSent, emailsFailed });

      logger.info(
        { orgId: org.id, orgName: org.name, tier, emailsSent, emailsFailed },
        'Digest processed for org',
      );
    } catch (err) {
      logger.error({ orgId: org.id, err }, 'Digest failed for org — continuing with next');
      results.push({ orgId: org.id, orgName: org.name, tier: 'free', emailsSent: 0, emailsFailed: 0 });
    }
  }

  const totalSent = results.reduce((n, r) => n + r.emailsSent, 0);
  const totalFailed = results.reduce((n, r) => n + r.emailsFailed, 0);
  logger.info(
    { orgsProcessed: results.length, totalSent, totalFailed },
    'Weekly digest batch complete',
  );

  return results;
}
