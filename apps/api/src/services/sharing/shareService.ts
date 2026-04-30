import { randomBytes, createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/appError.js';
import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import * as sharesQueries from '../../db/queries/shares.js';
import * as aiSummariesQueries from '../../db/queries/aiSummaries.js';
import * as orgsQueries from '../../db/queries/orgs.js';
import { env } from '../../config.js';
import { SHARES } from 'shared/constants';
import type { InsightSnapshot } from 'shared/schemas';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function generateShareLink(
  orgId: number,
  datasetId: number,
  createdBy: number,
  client?: typeof db | DbTransaction,
) {
  const summary = await aiSummariesQueries.getCachedSummary(orgId, datasetId, client);
  if (!summary) {
    throw new ValidationError('Generate an AI summary first, no cached summary exists for this dataset');
  }

  // orgs table has no RLS, no org_id column, it IS the org entity
  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  const meta = summary.transparencyMetadata as Record<string, unknown> | null;
  const dateRange = (meta && typeof meta.dateRange === 'string') ? meta.dateRange : 'Date range unavailable';

  const snapshot: InsightSnapshot = {
    orgName: org.name,
    dateRange,
    aiSummaryContent: summary.content,
    chartConfig: {},
  };

  const raw = randomBytes(SHARES.TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SHARES.DEFAULT_EXPIRY_DAYS);

  const share = await sharesQueries.createShare(orgId, datasetId, tokenHash, snapshot, createdBy, expiresAt, client);

  logger.info({ orgId, shareId: share.id, datasetId }, 'Share link generated');

  return { id: share.id, token: raw, url: `${env.APP_URL}/share/${raw}`, expiresAt: share.expiresAt };
}

/** Public share lookup, uses dbAdmin because there's no authenticated user to set RLS context */
export async function getSharedInsight(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const share = await sharesQueries.findByTokenHash(tokenHash, dbAdmin);

  if (!share) {
    throw new NotFoundError('Share not found');
  }

  if (share.expiresAt && share.expiresAt < new Date()) {
    throw new AppError('This share link has expired', 'GONE', 410);
  }

  await sharesQueries.incrementViewCount(share.id, dbAdmin);

  const snapshot = share.insightSnapshot as InsightSnapshot;

  return {
    orgName: snapshot.orgName,
    dateRange: snapshot.dateRange,
    aiSummaryContent: snapshot.aiSummaryContent,
    chartConfig: snapshot.chartConfig,
    viewCount: share.viewCount + 1,
  };
}
