import { eq, desc, and, gte, lte, lt, count, sql, type SQL } from 'drizzle-orm';
import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import { analyticsEvents, orgs, users } from '../schema.js';
import { ANALYTICS_EVENTS, type AnalyticsEventName } from 'shared/constants';

// Must match dedupeKey's varchar(200) column in schema.ts.
const DEDUPE_KEY_MAX_LENGTH = 200;

export async function recordEvent(
  orgId: number | null,
  userId: number | null,
  eventName: AnalyticsEventName,
  metadata?: Record<string, unknown>,
  client: typeof db | DbTransaction = db,
  dedupeKey?: string,
) {
  // Boolean(), not a null check: an empty string is falsy here too, so it's
  // treated the same as "no dedupe key" on both the write and the conflict
  // branch below instead of silently sneaking into the unique index.
  const hasDedupeKey = Boolean(dedupeKey);
  if (dedupeKey) {
    // Spread to count code points, not UTF-16 units, so surrogate-pair
    // characters (emoji, some CJK) match how Postgres counts varchar length.
    const dedupeKeyLength = [...dedupeKey].length;
    if (dedupeKeyLength > DEDUPE_KEY_MAX_LENGTH) {
      throw new Error(`dedupeKey is ${dedupeKeyLength} chars, exceeds the ${DEDUPE_KEY_MAX_LENGTH}-char column limit`);
    }
  }
  const insert = client
    .insert(analyticsEvents)
    .values({ orgId, userId, eventName, metadata: metadata ?? null, dedupeKey: hasDedupeKey ? dedupeKey : null });

  const [event] = hasDedupeKey
    ? await insert
        .onConflictDoNothing({
          target: analyticsEvents.dedupeKey,
          where: sql`${analyticsEvents.dedupeKey} IS NOT NULL`,
        })
        .returning()
    : await insert.returning();

  if (!event) {
    if (hasDedupeKey) return null;
    throw new Error('Insert failed to return analytics event');
  }
  return event;
}

interface GetEventsOpts {
  limit?: number;
  offset?: number;
}

export async function getEventsByOrg(
  orgId: number,
  opts: GetEventsOpts = {},
  client: typeof db | DbTransaction = db,
) {
  const { limit = 50, offset = 0 } = opts;

  return client.query.analyticsEvents.findMany({
    where: eq(analyticsEvents.orgId, orgId),
    orderBy: desc(analyticsEvents.createdAt),
    limit,
    offset,
  });
}

// Cross-org queries, no orgId required. Gated by roleGuard('admin') at route layer.

export interface AdminEventsFilter {
  eventName?: string;
  orgId?: number;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

function buildFilterConditions(opts: AdminEventsFilter): SQL | undefined {
  const conditions: SQL[] = [];

  if (opts.eventName) conditions.push(eq(analyticsEvents.eventName, opts.eventName));
  if (opts.orgId) conditions.push(eq(analyticsEvents.orgId, opts.orgId));
  if (opts.startDate) conditions.push(gte(analyticsEvents.createdAt, opts.startDate));
  if (opts.endDate) conditions.push(lte(analyticsEvents.createdAt, opts.endDate));

  return conditions.length ? and(...conditions) : undefined;
}

export async function getAllAnalyticsEvents(opts: AdminEventsFilter) {
  const { limit = 50, offset = 0 } = opts;
  const where = buildFilterConditions(opts);

  return dbAdmin
    .select({
      id: analyticsEvents.id,
      eventName: analyticsEvents.eventName,
      orgName: orgs.name,
      userEmail: users.email,
      metadata: analyticsEvents.metadata,
      createdAt: analyticsEvents.createdAt,
    })
    .from(analyticsEvents)
    // leftJoin: system-emitted rows (webhook events) have NULL org_id/user_id
    // and would silently drop from the admin feed if these were inner joins.
    .leftJoin(orgs, eq(orgs.id, analyticsEvents.orgId))
    .leftJoin(users, eq(users.id, analyticsEvents.userId))
    .where(where)
    .orderBy(desc(analyticsEvents.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getAnalyticsEventsTotal(opts: AdminEventsFilter) {
  const where = buildFilterConditions(opts);

  const [row] = await dbAdmin
    .select({ value: count() })
    .from(analyticsEvents)
    .where(where);

  return row?.value ?? 0;
}

export async function deleteOlderThan(retentionDays: number): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await dbAdmin
    .delete(analyticsEvents)
    .where(lt(analyticsEvents.createdAt, cutoff))
    .returning({ id: analyticsEvents.id });

  return deleted.length;
}

export async function getMonthlyAiUsageCount(
  orgId: number,
  client: typeof db | DbTransaction = dbAdmin,
): Promise<number> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [row] = await client
    .select({ value: count() })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.orgId, orgId),
        eq(analyticsEvents.eventName, ANALYTICS_EVENTS.AI_SUMMARY_COMPLETED),
        gte(analyticsEvents.createdAt, monthStart),
      ),
    );

  return row?.value ?? 0;
}

export interface AiUsageStats {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

// The largest Anthropic context window is an order of magnitude under this, so a
// row above the ceiling was forged rather than measured. Dropping it keeps the
// admin cost tile meaningful; returning numeric instead of int is what makes an
// overflow impossible either way.
const MAX_TOKENS_PER_EVENT = 10_000_000;

function sumTokenField(field: 'inputTokens' | 'outputTokens') {
  return sql<string>`COALESCE(SUM(
    CASE WHEN jsonb_typeof(${analyticsEvents.metadata}->${field}) = 'number' THEN
      CASE WHEN (${analyticsEvents.metadata}->>${field})::numeric BETWEEN 0 AND ${MAX_TOKENS_PER_EVENT}
           THEN (${analyticsEvents.metadata}->>${field})::numeric
      END
    END
  ), 0)::numeric`;
}

/**
 * Sum AI token usage across all orgs within a time window. Pulls from the
 * `AI_SUMMARY_COMPLETED` event's JSONB metadata (where the SSE stream records
 * per-request `inputTokens`/`outputTokens` after each Anthropic call). Used
 * by the admin dashboard cost tile, caller scopes the window (default is
 * month-to-date via getMonthToDateAiUsage).
 *
 * `COALESCE` yields 0 when the filter matches no rows (empty month, new
 * deploy). Everything else here exists because metadata is caller-written:
 * POST /analytics/events allowlists the event name and then stores whatever
 * metadata arrives, so both of these used to 500 the admin dashboard for good
 * off a single forged row. A non-numeric value raised 22P02, and a valid but
 * absurd JSON number raised 22003 on the way back to int.
 *
 * Nested CASE rather than an AND chain: CASE has a defined evaluation order,
 * where an AND's operands can be reordered by the planner and the cast could
 * run before its own guard.
 */
export async function getAiUsageStats(
  windowStart: Date,
  client: typeof db | DbTransaction = dbAdmin,
): Promise<AiUsageStats> {
  const [row] = await client
    .select({
      inputTokens: sumTokenField('inputTokens'),
      outputTokens: sumTokenField('outputTokens'),
      requestCount: count(),
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventName, ANALYTICS_EVENTS.AI_SUMMARY_COMPLETED),
        gte(analyticsEvents.createdAt, windowStart),
      ),
    );

  // numeric comes back as a string to keep precision, so coerce here rather
  // than letting every consumer do arithmetic on '1500'.
  return {
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    requestCount: row?.requestCount ?? 0,
  };
}

export async function getMonthToDateAiUsage(
  client: typeof db | DbTransaction = dbAdmin,
): Promise<AiUsageStats> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  return getAiUsageStats(monthStart, client);
}
