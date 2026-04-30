# QuickBooks Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the QuickBooks integration with frontend UI, comprehensive testing, staging deployment, and error monitoring.

**Architecture:** Two frontend components (upload page QB card, dashboard stale nudge), Sentry instrumentation on the existing sync pipeline, admin panel sync health, 25 Playwright E2E tests, ~35 Vitest integration tests, staging deployment workflow, and Intuit app review prep.

**Tech Stack:** Next.js 16 (React 19), Tailwind CSS 4, Playwright, Vitest, Sentry, Drizzle ORM, BullMQ, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-04-17-quickbooks-completion-design.md`

---

## Task 1: Upload Page, QuickBooks Card (QB-8)

**Files:**
- Create: `apps/web/app/upload/QuickBooksCard.tsx`
- Modify: `apps/web/app/upload/page.tsx`

### Prerequisites
Read these files before starting:
- `apps/web/app/upload/page.tsx`, current upload page layout
- `apps/web/app/upload/UploadDropzone.tsx`, existing CSV dropzone component
- `apps/web/lib/api-client.ts`, `apiClient<T>()` fetch helper
- `apps/web/app/settings/integrations/IntegrationsManager.tsx`, existing QB connect flow for reference

- [ ] **Step 1: Create QuickBooksCard component**

```tsx
// apps/web/app/upload/QuickBooksCard.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Link2, Link2Off, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { apiClient } from '@/lib/api-client';

interface QbStatus {
  connected: boolean;
  companyName?: string;
}

export function QuickBooksCard() {
  const [status, setStatus] = useState<QbStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient<QbStatus>('/integrations/quickbooks/status');
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function connect() {
    setConnecting(true);
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/quickbooks/connect', {
        method: 'POST',
      });
      window.location.href = data.authUrl;
    } catch {
      setConnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border/60 bg-card p-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card p-8 text-center">
        <Link2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm font-semibold text-foreground">QuickBooks Connected</p>
        <p className="text-xs text-muted-foreground">
          {status.companyName ?? 'Your company'} is syncing automatically.
        </p>
        <Link
          href="/settings/integrations"
          className="mt-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
        >
          Manage in Integrations
        </Link>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card p-8 text-center transition-colors hover:border-border hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Link2Off className="h-7 w-7 text-muted-foreground" />
      <p className="text-sm font-semibold text-foreground">Connect QuickBooks</p>
      <p className="text-xs text-muted-foreground">Auto-sync your accounting data</p>
      <span className="mt-1 rounded-md bg-[#2ca01c] px-4 py-1.5 text-xs font-medium text-white">
        {connecting ? 'Connecting...' : 'Connect'}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Update upload page layout to side-by-side grid**

Read `apps/web/app/upload/page.tsx` to see the current structure. Wrap the existing `UploadDropzone` and the new `QuickBooksCard` in a 2-column grid:

```tsx
// In apps/web/app/upload/page.tsx, modify the layout section
// Add import at the top:
import { QuickBooksCard } from './QuickBooksCard';

// Wrap the dropzone and QB card in a grid:
<div className="grid grid-cols-1 gap-6 md:grid-cols-2">
  <UploadDropzone />
  <QuickBooksCard />
</div>
```

The exact edit depends on the current page structure. Read the file, find where `<UploadDropzone />` is rendered, and wrap it in the grid with the QB card beside it. Add an "or" divider between them on mobile:

```tsx
<div className="grid grid-cols-1 gap-6 md:grid-cols-2">
  <UploadDropzone />
  <div className="flex items-center justify-center md:hidden">
    <span className="text-xs text-muted-foreground">or</span>
  </div>
  <QuickBooksCard />
</div>
```

- [ ] **Step 3: Verify lint and type-check pass**

Run: `pnpm -C apps/web type-check && pnpm -C apps/web lint`
Expected: Both pass with no errors.

- [ ] **Step 4: Visual check in browser**

Start the web dev server (`pnpm -C apps/web dev`), navigate to `/upload`, verify:
- Two cards side by side on desktop
- Cards stack on mobile (resize to 375px)
- QB card shows loading spinner briefly, then "Connect QuickBooks"
- If API is down, QB card shows "Connect QuickBooks" (fails silently to disconnected state)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/upload/QuickBooksCard.tsx apps/web/app/upload/page.tsx
git commit -m "feat: add QuickBooks card to upload page (QB-8)"
```

---

## Task 2: Stale Nudge, Backend (QB-9 Part 1)

**Files:**
- Create: `apps/api/drizzle/migrations/0018_add-stale-reason.sql`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/queries/aiSummaries.ts`
- Modify: `apps/api/src/services/integrations/quickbooks/sync.ts`
- Modify: `apps/api/src/routes/datasets.ts`

### Prerequisites
Read these files before starting:
- `apps/api/src/db/schema.ts`, find the `aiSummaries` table definition (around line 183)
- `apps/api/src/db/queries/aiSummaries.ts`, `markStale()` function signature
- `apps/api/src/services/integrations/quickbooks/sync.ts`, where `markStale()` is called
- `apps/api/src/routes/datasets.ts`, where CSV upload triggers `markStale()`

- [ ] **Step 1: Write the migration**

```sql
-- apps/api/drizzle/migrations/0018_add-stale-reason.sql
ALTER TABLE ai_summaries ADD COLUMN stale_reason text;
```

- [ ] **Step 2: Add column to Drizzle schema**

In `apps/api/src/db/schema.ts`, find the `aiSummaries` table definition and add the column after `staleAt`:

```ts
staleReason: text('stale_reason'),
```

- [ ] **Step 3: Update markStale() to accept a reason**

In `apps/api/src/db/queries/aiSummaries.ts`, update the `markStale` function signature and body:

```ts
// Change from:
export async function markStale(orgId: number, client: DbClient, datasetId?: number)
// To:
export async function markStale(orgId: number, client: DbClient, reason: 'sync' | 'upload' | 'manual', datasetId?: number)
```

In the update body, add `staleReason: reason` alongside the existing `staleAt: new Date()`:

```ts
.set({ staleAt: new Date(), staleReason: reason })
```

- [ ] **Step 4: Update getCachedSummary() to return stale fields**

In `apps/api/src/db/queries/aiSummaries.ts`, verify `getCachedSummary()` returns the full row. If it filters out `staleAt`, ensure both `staleAt` and `staleReason` are included in the response so the frontend can detect staleness.

- [ ] **Step 5: Update sync.ts to pass 'sync' reason**

In `apps/api/src/services/integrations/quickbooks/sync.ts`, find the `markStale()` call and add the reason argument:

```ts
// Change from:
await markStale(connection.orgId, dbAdmin, datasetId);
// To:
await markStale(connection.orgId, dbAdmin, 'sync', datasetId);
```

- [ ] **Step 6: Update datasets.ts to pass 'upload' reason**

In `apps/api/src/routes/datasets.ts`, find where `markStale()` is called after CSV upload and add the reason:

```ts
// Change from:
await markStale(orgId, dbAdmin);
// To:
await markStale(orgId, dbAdmin, 'upload');
```

Search for any other `markStale()` call sites and update them all. If there's a manual refresh path, use `'manual'`.

- [ ] **Step 7: Run tests and type-check**

Run: `pnpm -C apps/api type-check && pnpm -C apps/api test`
Expected: Type-check passes. Tests pass (existing tests may need the new `reason` argument added to their `markStale()` calls, fix any failures).

- [ ] **Step 8: Commit**

```bash
git add apps/api/drizzle/migrations/0018_add-stale-reason.sql apps/api/src/db/schema.ts apps/api/src/db/queries/aiSummaries.ts apps/api/src/services/integrations/quickbooks/sync.ts apps/api/src/routes/datasets.ts
git commit -m "feat: add stale_reason column to ai_summaries (QB-9)"
```

---

## Task 3: Stale Nudge, Frontend (QB-9 Part 2)

**Files:**
- Modify: `apps/web/app/dashboard/AiSummaryCard.tsx`

### Prerequisites
Read these files before starting:
- `apps/web/app/dashboard/AiSummaryCard.tsx`, full component (405 lines, client component)
- `apps/web/app/dashboard/hooks/useAiStream.ts`, the SSE streaming hook used for AI summaries

- [ ] **Step 1: Add stale nudge footer to AiSummaryCard**

In `apps/web/app/dashboard/AiSummaryCard.tsx`, add the stale nudge as a footer inside the card's outer container. The component receives cached summary data from props, check if `staleAt` and `staleReason` are in the response.

Add the stale footer at the bottom of the card, inside the outermost `<div>`:

```tsx
{staleAt && !isStreaming && (
  <div className="flex items-center justify-between border-t border-border/30 bg-amber-50 px-5 py-2.5 dark:bg-amber-950/20">
    <span className="text-xs text-amber-800 dark:text-amber-200">
      {staleReason === 'sync' ? 'New QuickBooks data available' : 'New data uploaded'}
    </span>
    <button
      onClick={handleRefresh}
      disabled={isRefreshing}
      className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
    >
      {isRefreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>
)}
```

- [ ] **Step 2: Implement handleRefresh**

The refresh action should trigger a new AI summary generation using the existing SSE endpoint. Look at how the initial summary generation is triggered (likely via `useAiStream` hook) and replicate that:

```tsx
const [isRefreshing, setIsRefreshing] = useState(false);

async function handleRefresh() {
  setIsRefreshing(true);
  try {
    // Trigger the existing AI summary regeneration
    // This depends on how useAiStream works, it may accept a force param
    // or you may need to call the SSE endpoint directly
    await onRegenerate?.(); // if the parent passes a regenerate callback
  } catch {
    // Show error toast, nudge stays visible for retry
    setIsRefreshing(false);
  }
}
```

Read `useAiStream` to understand the regeneration mechanism. The refresh should:
1. Clear the stale flag locally (optimistic)
2. Trigger SSE stream for new summary
3. On success: stale nudge disappears (staleAt is null in new response)
4. On failure: show error, keep nudge visible, reset `isRefreshing`

- [ ] **Step 3: Verify staleAt and staleReason reach the component**

Trace the data flow: API response → BFF proxy → page component → `AiSummaryCard` props. Ensure `staleAt` and `staleReason` are passed through. You may need to update the summary fetch endpoint or the page component that fetches and passes props.

- [ ] **Step 4: Lint and type-check**

Run: `pnpm -C apps/web type-check && pnpm -C apps/web lint`
Expected: Both pass.

- [ ] **Step 5: Visual check**

To test the stale nudge without a real QB sync:
1. Manually set `stale_at = NOW()` and `stale_reason = 'sync'` on an `ai_summaries` row in the DB
2. Load the dashboard
3. Verify the amber footer appears at the bottom of the AI summary card
4. Click "Refresh", verify the summary regenerates (requires API + Claude key)
5. After refresh, verify the footer disappears

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/dashboard/AiSummaryCard.tsx
git commit -m "feat: add stale data nudge to AI summary card (QB-9)"
```

---

## Task 4: Sentry Breadcrumbs on Sync Lifecycle (QB-10 Part 1)

**Files:**
- Modify: `apps/api/src/services/integrations/quickbooks/sync.ts`
- Modify: `apps/api/src/lib/sentry.ts` (if needed)

### Prerequisites
Read these files before starting:
- `apps/api/src/services/integrations/quickbooks/sync.ts`, the `runSync()` function
- `apps/api/src/lib/sentry.ts`, Sentry setup, exports `Sentry` instance

- [ ] **Step 1: Add Sentry import to sync.ts**

```ts
import { Sentry } from '../../lib/sentry.js';
```

- [ ] **Step 2: Add breadcrumbs at each sync stage**

Add `Sentry.addBreadcrumb()` calls at each stage within `runSync()`. Place them at the natural boundaries, after each major operation completes:

```ts
// At start of runSync():
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.started',
  data: { orgId: connection.orgId, connectionId, trigger },
  level: 'info',
});

// After each QB API fetch (inside the entity loop):
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.fetch',
  data: { entityType, rowCount: rows.length, durationMs },
  level: 'info',
});

// After normalize:
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.normalize',
  data: { inputRows: rawRows.length, outputRows: normalized.length },
  level: 'info',
});

// After upsert:
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.upsert',
  data: { insertedCount, updatedCount, batchNumber },
  level: 'info',
});

// After markStale:
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.stale',
  data: { orgId: connection.orgId },
  level: 'info',
});

// At end of runSync (success):
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'sync.completed',
  data: { totalRows: result.rowsSynced, durationMs: Date.now() - startTime },
  level: 'info',
});
```

- [ ] **Step 3: Capture sync failures as Sentry events**

In the catch block of `runSync()`, capture the error with context:

```ts
catch (err) {
  Sentry.addBreadcrumb({
    category: 'sync',
    message: 'sync.failed',
    data: { error: err instanceof Error ? err.message : String(err), stage: currentStage, retryCount },
    level: 'error',
  });

  Sentry.captureException(err, {
    tags: { orgId: connection.orgId, trigger, provider: 'quickbooks' },
    extra: { connectionId, stage: currentStage },
  });

  throw err; // re-throw for BullMQ retry handling
}
```

Add a `currentStage` variable at the top of `runSync()` that you update as you progress through stages (`'fetch'`, `'normalize'`, `'upsert'`, `'stale'`).

- [ ] **Step 4: Guard breadcrumbs when Sentry is unconfigured**

The `Sentry` import from `lib/sentry.ts` exports the `@sentry/node` module. If `SENTRY_DSN` is not set, `Sentry.init()` wasn't called, but `Sentry.addBreadcrumb()` is a no-op in that case, it won't throw. Verify this by checking the Sentry SDK docs. No guard needed if the SDK handles this gracefully.

- [ ] **Step 5: Type-check and run tests**

Run: `pnpm -C apps/api type-check && pnpm -C apps/api test`
Expected: Both pass. Breadcrumbs are side-effect-only, no behavior change.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/integrations/quickbooks/sync.ts
git commit -m "feat: add Sentry breadcrumbs to QB sync lifecycle (QB-10)"
```

---

## Task 5: Admin Panel, Sync Health (QB-10 Part 2)

**Files:**
- Create: `apps/api/src/db/queries/syncHealth.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Create: `apps/web/app/admin/SyncHealthPanel.tsx`
- Modify: `apps/web/app/admin/page.tsx`

### Prerequisites
Read these files before starting:
- `apps/api/src/routes/admin.ts`, existing admin routes
- `apps/web/app/admin/page.tsx`, existing admin page layout
- `apps/web/app/admin/SystemHealthPanel.tsx`, pattern for health panels
- `apps/api/src/db/queries/syncJobs.ts`, existing sync job queries

- [ ] **Step 1: Create syncHealth query module**

```ts
// apps/api/src/db/queries/syncHealth.ts
import { count, eq, gte, desc, sql, and, isNotNull } from 'drizzle-orm';

import { dbAdmin } from '../index.js';
import { integrationConnections, syncJobs, orgs } from '../schema.js';

export async function getSyncHealthSummary() {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [activeConnections] = await dbAdmin
    .select({ count: count() })
    .from(integrationConnections)
    .where(eq(integrationConnections.provider, 'quickbooks'));

  const last24h = await dbAdmin
    .select({
      status: syncJobs.status,
      count: count(),
    })
    .from(syncJobs)
    .where(gte(syncJobs.createdAt, oneDayAgo))
    .groupBy(syncJobs.status);

  const [oldestSuccess] = await dbAdmin
    .select({
      orgName: orgs.name,
      lastSyncedAt: integrationConnections.lastSyncedAt,
    })
    .from(integrationConnections)
    .innerJoin(orgs, eq(orgs.id, integrationConnections.orgId))
    .where(isNotNull(integrationConnections.lastSyncedAt))
    .orderBy(integrationConnections.lastSyncedAt)
    .limit(1);

  const recentErrors = await dbAdmin
    .select({
      orgName: orgs.name,
      error: syncJobs.error,
      createdAt: syncJobs.createdAt,
    })
    .from(syncJobs)
    .innerJoin(
      integrationConnections,
      eq(integrationConnections.id, syncJobs.connectionId),
    )
    .innerJoin(orgs, eq(orgs.id, integrationConnections.orgId))
    .where(eq(syncJobs.status, 'failed'))
    .orderBy(desc(syncJobs.createdAt))
    .limit(5);

  const syncCounts = { successful: 0, failed: 0, pending: 0 };
  for (const row of last24h) {
    if (row.status === 'completed') syncCounts.successful = row.count;
    else if (row.status === 'failed') syncCounts.failed = row.count;
    else syncCounts.pending += row.count;
  }

  return {
    activeConnections: activeConnections?.count ?? 0,
    last24h: syncCounts,
    oldestSuccess: oldestSuccess ?? null,
    recentErrors,
  };
}
```

- [ ] **Step 2: Add admin route for sync health**

In `apps/api/src/routes/admin.ts`, add a new endpoint:

```ts
import { getSyncHealthSummary } from '../db/queries/syncHealth.js';

// Add inside the admin router:
router.get('/sync-health', async (_req, res) => {
  const health = await getSyncHealthSummary();
  res.json({ data: health });
});
```

- [ ] **Step 3: Create SyncHealthPanel component**

```tsx
// apps/web/app/admin/SyncHealthPanel.tsx
interface SyncHealth {
  activeConnections: number;
  last24h: { successful: number; failed: number; pending: number };
  oldestSuccess: { orgName: string; lastSyncedAt: string } | null;
  recentErrors: Array<{ orgName: string; error: string; createdAt: string }>;
}

export function SyncHealthPanel({ data }: { data: SyncHealth }) {
  const oldestAge = data.oldestSuccess
    ? Math.round((Date.now() - new Date(data.oldestSuccess.lastSyncedAt).getTime()) / 3600000)
    : null;
  const isStale = oldestAge !== null && oldestAge > 48;

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">QuickBooks Sync Health</h2>

      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Active connections" value={data.activeConnections} />
        <Stat label="Syncs (24h)" value={data.last24h.successful} sub="successful" />
        <Stat label="Failed (24h)" value={data.last24h.failed} warn={data.last24h.failed > 0} />
        <Stat label="Pending" value={data.last24h.pending} />
      </div>

      {oldestAge !== null && (
        <p className={`mt-3 text-xs ${isStale ? 'text-destructive' : 'text-muted-foreground'}`}>
          Oldest sync: {data.oldestSuccess!.orgName}, {oldestAge}h ago
          {isStale && ' (stale, >48h)'}
        </p>
      )}

      {data.recentErrors.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-destructive">Recent errors</p>
          <ul className="mt-1 space-y-1">
            {data.recentErrors.map((e, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="font-medium">{e.orgName}</span>: {e.error}{' '}
                <span className="text-muted-foreground/60">
                  ({new Date(e.createdAt).toLocaleString()})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: number; sub?: string; warn?: boolean }) {
  return (
    <div>
      <p className={`text-xl font-semibold ${warn ? 'text-destructive' : 'text-foreground'}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Add SyncHealthPanel to admin page**

In `apps/web/app/admin/page.tsx`, add a fetch for sync health data and render the panel:

```tsx
import { SyncHealthPanel } from './SyncHealthPanel';

// Add alongside existing fetches:
async function fetchSyncHealth() {
  const res = await fetch(`${API_URL}/admin/sync-health`, { /* auth headers */ });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data;
}

// In the component, call it in parallel with existing fetches:
const [orgs, users, syncHealth] = await Promise.all([
  fetchAdminOrgs(),
  fetchAdminUsers(),
  fetchSyncHealth(),
]);

// Render after existing panels:
{syncHealth && <SyncHealthPanel data={syncHealth} />}
```

- [ ] **Step 5: Type-check and lint**

Run: `pnpm type-check && pnpm lint`
Expected: Both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/queries/syncHealth.ts apps/api/src/routes/admin.ts apps/web/app/admin/SyncHealthPanel.tsx apps/web/app/admin/page.tsx
git commit -m "feat: add sync health panel to admin dashboard (QB-10)"
```

---

## Task 6: Integration Tests, Sync Orchestrator (QB-11 Part 1)

**Files:**
- Create: `apps/api/src/services/integrations/quickbooks/__tests__/sync.test.ts`
- Create: `apps/api/src/services/integrations/quickbooks/__tests__/fixtures.ts`

### Prerequisites
Read these files before starting:
- `apps/api/src/services/integrations/quickbooks/sync.ts`, `runSync()`, `SyncResult`
- `apps/api/src/services/integrations/quickbooks/api.ts`, `createQbClient()` signature
- `apps/api/src/services/integrations/quickbooks/normalize.ts`, normalizer input/output types
- `apps/api/src/db/queries/integrationConnections.ts`, connection query functions
- Existing test files for patterns (e.g., `apps/api/src/services/curation/__tests__/`)

- [ ] **Step 1: Create test fixtures**

Create canned QB API responses for the mock client:

```ts
// apps/api/src/services/integrations/quickbooks/__tests__/fixtures.ts
export const mockConnection = {
  id: 1,
  orgId: 1,
  provider: 'quickbooks' as const,
  realmId: 'test-realm-123',
  accessToken: 'encrypted-access-token',
  refreshToken: 'encrypted-refresh-token',
  tokenExpiresAt: new Date(Date.now() + 3600000),
  companyName: 'Test Company',
  lastSyncedAt: null,
  syncStatus: 'idle' as const,
  syncError: null,
  createdAt: new Date(),
};

export const mockInvoiceResponse = {
  QueryResponse: {
    Invoice: [
      {
        Id: 'inv-1',
        TxnDate: '2026-03-15',
        TotalAmt: 1500.00,
        MetaData: { LastUpdatedTime: '2026-03-15T10:00:00Z' },
        Line: [
          {
            Amount: 1000.00,
            Description: 'Web design services',
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { name: 'Design' } },
          },
          {
            Amount: 500.00,
            Description: 'Hosting setup',
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { name: 'Hosting' } },
          },
        ],
      },
    ],
    maxResults: 1,
  },
};

export const mockPurchaseResponse = {
  QueryResponse: {
    Purchase: [
      {
        Id: 'pur-1',
        TxnDate: '2026-03-16',
        TotalAmt: 250.00,
        MetaData: { LastUpdatedTime: '2026-03-16T08:00:00Z' },
        Line: [
          {
            Amount: 250.00,
            Description: 'Office supplies',
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: { AccountRef: { name: 'Supplies' } },
          },
        ],
      },
    ],
    maxResults: 1,
  },
};

export function createMockQbClient(responses: Record<string, unknown> = {}) {
  return {
    query: vi.fn(async (entityType: string) => {
      return responses[entityType] ?? { QueryResponse: { [entityType]: [], maxResults: 0 } };
    }),
  };
}
```

- [ ] **Step 2: Write sync orchestrator tests**

```ts
// apps/api/src/services/integrations/quickbooks/__tests__/sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMockQbClient, mockConnection, mockInvoiceResponse, mockPurchaseResponse } from './fixtures.js';

// Mock the dependencies
vi.mock('../../lib/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn(), captureException: vi.fn() },
}));

// Test structure, implement each test body by reading the actual runSync() code
// and mocking the DB queries it calls

describe('runSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates dataset on initial sync when no QB dataset exists', async () => {
    // Mock: no existing QB dataset for this org
    // Mock: QB client returns invoice + purchase data
    // Assert: dataset created with name "QuickBooks, Test Company"
    // Assert: activeDatasetId set on the org
  });

  it('uses lastSyncedAt for incremental sync', async () => {
    // Mock: connection.lastSyncedAt = 2 days ago
    // Assert: QB client.query called with WHERE clause including lastSyncedAt
  });

  it('upserts rows without duplicates via source_id', async () => {
    // Run sync twice with same data
    // Assert: data_rows count is same after second sync (no duplicates)
  });

  it('marks AI summaries stale after successful sync', async () => {
    // Mock: successful sync
    // Assert: markStale called with orgId and reason 'sync'
  });

  it('handles partial failure, writes checkpoint before throwing', async () => {
    // Mock: first entity type succeeds, second throws
    // Assert: first batch of rows were written
    // Assert: sync job status is 'failed' with error message
    // Assert: error is re-thrown for BullMQ retry
  });

  it('emits analytics events for sync lifecycle', async () => {
    // Mock: successful sync
    // Assert: trackEvent called with 'integration.synced' event
  });

  it('handles empty QB account gracefully', async () => {
    // Mock: all entity types return empty arrays
    // Assert: sync completes with rowsSynced: 0
    // Assert: no dataset created (nothing to show)
  });

  it('batches upserts at 500 rows', async () => {
    // Mock: 1200 normalized rows
    // Assert: 3 upsert calls (500 + 500 + 200)
  });
});
```

Fill in each test body after reading the actual `runSync()` implementation. The mocking strategy depends on how `runSync()` is structured, whether it imports query functions directly or accepts them as dependencies.

- [ ] **Step 3: Run the tests**

Run: `pnpm -C apps/api test -- --grep "runSync"`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/integrations/quickbooks/__tests__/
git commit -m "test: add sync orchestrator integration tests (QB-11)"
```

---

## Task 7: Integration Tests, Routes + Worker (QB-11 Part 2)

**Files:**
- Create: `apps/api/src/routes/__tests__/integrations.test.ts`
- Create: `apps/api/src/services/integrations/__tests__/worker.test.ts`

### Prerequisites
Read these files before starting:
- `apps/api/src/routes/integrations.ts`, route handlers
- `apps/api/src/services/integrations/worker.ts`, BullMQ worker
- Existing route test files for patterns (e.g., `apps/api/src/routes/__tests__/`)

- [ ] **Step 1: Write route handler tests**

Test each route in `integrations.ts` using supertest or the existing test pattern for Express routes in this codebase:

```ts
// apps/api/src/routes/__tests__/integrations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('QB Integration Routes', () => {
  describe('POST /integrations/quickbooks/connect', () => {
    it('returns authUrl and sets state cookie', async () => {
      // Mock: authenticated user with org
      // Assert: response contains authUrl starting with https://appcenter.intuit.com
      // Assert: response sets httpOnly state cookie
    });
  });

  describe('GET /integrations/quickbooks/callback', () => {
    it('exchanges code for tokens and creates connection', async () => {
      // Mock: valid state cookie, valid auth code
      // Assert: connection created in DB
      // Assert: sync job enqueued
      // Assert: redirects to /settings/integrations
    });

    it('returns error when user denies consent', async () => {
      // Mock: callback with error=access_denied query param
      // Assert: no connection created
      // Assert: redirects with error message
    });

    it('rejects invalid state cookie (CSRF)', async () => {
      // Mock: mismatched state cookie
      // Assert: 403 response
    });
  });

  describe('GET /integrations/quickbooks/status', () => {
    it('returns connection status for authenticated user', async () => {
      // Mock: existing connection
      // Assert: response includes connected: true, companyName, syncStatus
    });

    it('returns connected: false when no connection exists', async () => {
      // Mock: no connection for this org
      // Assert: response includes connected: false
    });
  });

  describe('POST /integrations/quickbooks/sync', () => {
    it('enqueues manual sync job', async () => {
      // Mock: existing connection
      // Assert: job enqueued with trigger: 'manual'
    });
  });

  describe('DELETE /integrations/quickbooks', () => {
    it('owner can disconnect', async () => {
      // Mock: authenticated as owner
      // Assert: connection deleted, token revoked, scheduler job removed
    });

    it('member cannot disconnect', async () => {
      // Mock: authenticated as member
      // Assert: 403 response
    });
  });
});
```

- [ ] **Step 2: Write worker tests**

```ts
// apps/api/src/services/integrations/__tests__/worker.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Sync Worker', () => {
  it('calls runSync with correct connection ID and trigger', async () => {
    // Mock: job with data { connectionId: 1, trigger: 'daily' }
    // Assert: runSync called with (1, 'daily')
  });

  it('does not retry on TokenRevokedError', async () => {
    // Mock: runSync throws TokenRevokedError
    // Assert: error is marked as terminal (UnrecoverableError)
  });

  it('retries on retryable errors with backoff', async () => {
    // Mock: runSync throws RetryableError
    // Assert: error propagates (BullMQ handles retry via job config)
  });
});
```

- [ ] **Step 3: Run all QB tests**

Run: `pnpm -C apps/api test -- --grep "QB|quickbooks|Sync"`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/__tests__/integrations.test.ts apps/api/src/services/integrations/__tests__/worker.test.ts
git commit -m "test: add route handler and worker integration tests (QB-11)"
```

---

## Task 8: Playwright E2E Tests (QB-12)

**Files:**
- Create: `apps/web/e2e/quickbooks.spec.ts`

### Prerequisites
Read these files before starting:
- `e2e/dashboard.spec.ts`, existing Playwright test patterns, locator strategies
- `playwright.config.ts`, test directory config, base URL, timeouts
- `apps/web/app/upload/QuickBooksCard.tsx`, selectors for the QB card
- `apps/web/app/settings/integrations/IntegrationsManager.tsx`, selectors for integrations page
- `apps/web/app/dashboard/AiSummaryCard.tsx`, selectors for stale nudge

- [ ] **Step 1: Create the E2E test file with route mocking helpers**

```ts
// apps/web/e2e/quickbooks.spec.ts
import { test, expect } from '@playwright/test';

// Helper: mock QB API responses via page.route()
async function mockQbStatus(page, status: 'connected' | 'disconnected' | 'error' | 'syncing', overrides = {}) {
  const defaults = {
    connected: {
      connected: true,
      companyName: 'Test Company',
      syncStatus: 'idle',
      lastSyncedAt: new Date().toISOString(),
    },
    disconnected: { connected: false },
    error: {
      connected: true,
      companyName: 'Test Company',
      syncStatus: 'error',
      syncError: 'Token revoked, please reconnect',
    },
    syncing: {
      connected: true,
      companyName: 'Test Company',
      syncStatus: 'syncing',
    },
  };

  await page.route('**/api/integrations/quickbooks/status', (route) =>
    route.fulfill({ json: { data: { ...defaults[status], ...overrides } } }),
  );
}

async function mockQbConnect(page) {
  await page.route('**/api/integrations/quickbooks/connect', (route) =>
    route.fulfill({
      json: { data: { authUrl: 'https://appcenter.intuit.com/connect/oauth2?mock=true' } },
    }),
  );
}

async function mockQbDisconnect(page) {
  await page.route('**/api/integrations/quickbooks', (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ json: { data: { success: true } } });
    }
    return route.fallback();
  });
}

async function mockDigestPrefs(page) {
  await page.route('**/api/preferences/digest', (route) =>
    route.fulfill({ json: { data: { digestOptIn: true } } }),
  );
}
```

- [ ] **Step 2: Write happy path tests (tests 1-4)**

```ts
test.describe('QuickBooks Integration', () => {
  test.describe('Happy Path', () => {
    test('connect from upload page', async ({ page }) => {
      await mockQbStatus(page, 'disconnected');
      await mockQbConnect(page);

      await page.goto('/upload');
      await expect(page.getByText('Connect QuickBooks')).toBeVisible();
      await page.getByText('Connect QuickBooks').click();

      // Verify redirect attempt to Intuit auth URL
      const [request] = await Promise.all([
        page.waitForRequest('**/api/integrations/quickbooks/connect'),
        page.getByRole('button', { name: /connect/i }).click(),
      ]);
      expect(request.method()).toBe('POST');
    });

    test('connect from integrations page', async ({ page }) => {
      await mockQbStatus(page, 'disconnected');
      await mockQbConnect(page);
      await mockDigestPrefs(page);

      await page.goto('/settings/integrations');
      await expect(page.getByText('QuickBooks Online')).toBeVisible();
      await page.getByRole('button', { name: /connect/i }).click();

      await page.waitForRequest('**/api/integrations/quickbooks/connect');
    });

    test('stale nudge appears and refresh works', async ({ page }) => {
      // Mock dashboard data with stale AI summary
      await page.route('**/api/datasets/*/summary', (route) =>
        route.fulfill({
          json: {
            data: {
              content: 'Old summary content...',
              staleAt: new Date().toISOString(),
              staleReason: 'sync',
            },
          },
        }),
      );

      await page.goto('/dashboard');
      await expect(page.getByText('New QuickBooks data available')).toBeVisible();

      // Click refresh, mock new summary without stale flag
      await page.route('**/api/datasets/*/summary', (route) =>
        route.fulfill({
          json: { data: { content: 'Updated summary...', staleAt: null, staleReason: null } },
        }),
      );
      await page.getByRole('button', { name: /refresh/i }).click();

      await expect(page.getByText('New QuickBooks data available')).not.toBeVisible();
    });

    test('disconnect preserves data on dashboard', async ({ page }) => {
      await mockQbStatus(page, 'connected');
      await mockQbDisconnect(page);
      await mockDigestPrefs(page);

      await page.goto('/settings/integrations');
      await page.getByRole('button', { name: /disconnect/i }).click();

      // After disconnect, mock status as disconnected
      await mockQbStatus(page, 'disconnected');

      // Navigate to dashboard, charts should still render
      await page.goto('/dashboard');
      // Verify chart container exists (data persists)
      await expect(page.locator('[data-testid="revenue-chart"], canvas')).toBeVisible();
    });
  });
});
```

- [ ] **Step 3: Write error, access, polling tests (tests 5-8)**

```ts
  test.describe('Error States', () => {
    test('OAuth denial shows error', async ({ page }) => {
      await mockQbStatus(page, 'disconnected');
      await mockDigestPrefs(page);
      await page.route('**/api/integrations/quickbooks/connect', (route) =>
        route.fulfill({ status: 400, json: { error: { code: 'OAUTH_DENIED', message: 'User denied access' } } }),
      );

      await page.goto('/settings/integrations');
      await page.getByRole('button', { name: /connect/i }).click();
      await expect(page.getByText(/denied|failed/i)).toBeVisible();
    });

    test('sync failure shows error with retry', async ({ page }) => {
      await mockQbStatus(page, 'error');
      await mockDigestPrefs(page);

      await page.goto('/settings/integrations');
      await expect(page.getByText(/token revoked/i)).toBeVisible();
    });
  });

  test.describe('Access Control', () => {
    test('non-owner cannot see disconnect button', async ({ page }) => {
      // Mock auth as member role
      await mockQbStatus(page, 'connected');
      await mockDigestPrefs(page);
      // Mock user role as member via auth endpoint
      await page.route('**/api/auth/me', (route) =>
        route.fulfill({ json: { data: { role: 'member' } } }),
      );

      await page.goto('/settings/integrations');
      await expect(page.getByRole('button', { name: /disconnect/i })).not.toBeVisible();
    });
  });

  test.describe('Polling', () => {
    test('sync polling shows progress and final state', async ({ page }) => {
      await mockQbStatus(page, 'connected');
      await mockDigestPrefs(page);

      await page.goto('/settings/integrations');

      // Mock sync trigger
      await page.route('**/api/integrations/quickbooks/sync', (route) =>
        route.fulfill({ json: { data: { jobId: 'test-job' } } }),
      );

      await page.getByRole('button', { name: /sync now/i }).click();

      // After poll, mock completed status
      await mockQbStatus(page, 'connected', {
        syncStatus: 'idle',
        lastSyncedAt: new Date().toISOString(),
      });

      // Verify final state shows updated timestamp
      await expect(page.getByText(/last synced/i)).toBeVisible();
    });
  });
```

- [ ] **Step 4: Write remaining tests (tests 9-25)**

Continue the pattern for the remaining 17 tests as specified in the spec. Each test follows the same structure:
1. Mock API responses via `page.route()`
2. Navigate to the relevant page
3. Interact with the UI
4. Assert the expected outcome

Group them in `test.describe` blocks matching the spec categories: Token Edge Cases, Data Edge Cases, UI Resilience, Network Resilience, Multi-org, Dashboard Integration, Upload Page, Stale Nudge Edge Cases, and Lifecycle.

For the lifecycle test (#25), chain all the mock transitions:
```ts
test('full lifecycle round-trip', async ({ page }) => {
  // 1. Start disconnected
  await mockQbStatus(page, 'disconnected');
  // 2. Connect
  // 3. Mock initial sync completion
  // 4. Verify dashboard shows data
  // 5. Trigger manual sync
  // 6. Verify stale nudge
  // 7. Refresh insights
  // 8. Disconnect
  // 9. Verify data persists
  // 10. Reconnect
  // 11. Verify no duplicates (check data count)
});
```

- [ ] **Step 5: Run the E2E tests**

Run: `npx playwright test apps/web/e2e/quickbooks.spec.ts`
Expected: All 25 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/quickbooks.spec.ts
git commit -m "test: add 25 Playwright E2E tests for QuickBooks flow (QB-12)"
```

---

## Task 9: Staging Deployment Workflow (QB-13)

**Files:**
- Create: `.github/workflows/deploy-staging.yml`
- Create: `docs/quickbooks-sandbox-checklist.md`

- [ ] **Step 1: Create staging deployment workflow**

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v5

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build
        env:
          API_INTERNAL_URL: ${{ vars.API_INTERNAL_URL }}

      - name: Deploy to Vercel (staging)
        run: |
          npx vercel deploy --prebuilt --token=${{ secrets.VERCEL_TOKEN }} \
            --scope=${{ vars.VERCEL_SCOPE }} \
            > deployment-url.txt
          echo "DEPLOYMENT_URL=$(cat deployment-url.txt)" >> $GITHUB_ENV

      - name: Verify deployment health
        run: |
          for i in $(seq 1 30); do
            if curl -sf "$DEPLOYMENT_URL/api/health" > /dev/null 2>&1; then
              echo "Staging healthy after ${i}s"
              exit 0
            fi
            sleep 2
          done
          echo "Staging health check failed"
          exit 1
```

- [ ] **Step 2: Create sandbox validation checklist**

```markdown
<!-- docs/quickbooks-sandbox-checklist.md -->
# QuickBooks Sandbox Validation Checklist

Run this checklist manually against the staging environment before each production deploy that touches QB code.

## Prerequisites
- [ ] Intuit developer account created
- [ ] Sandbox app created with redirect URI matching staging domain
- [ ] Staging environment has `QUICKBOOKS_*` env vars configured
- [ ] Staging DB has been migrated

## Validation Steps

### OAuth Flow
- [ ] Click "Connect QuickBooks" on upload page
- [ ] Redirected to Intuit consent screen
- [ ] Authorize, redirected back to integrations page
- [ ] Status shows "Connected to Sandbox Company_US_1"

### Initial Sync
- [ ] Sync starts automatically after connect
- [ ] Dashboard shows QB dataset in dataset switcher
- [ ] Charts render with sandbox transaction data
- [ ] `data_rows` count matches sandbox company transaction count

### Incremental Sync
- [ ] Click "Sync now" on integrations page
- [ ] Sync completes without duplicating rows
- [ ] `data_rows` count unchanged (no new sandbox data)

### Stale Nudge
- [ ] After sync, dashboard shows amber "New QuickBooks data available" footer
- [ ] Click "Refresh", new AI summary generates
- [ ] Amber footer disappears after refresh

### Disconnect
- [ ] Click "Disconnect" on integrations page
- [ ] Status returns to disconnected
- [ ] Dashboard still shows charts (data persists)
- [ ] Reconnect, no duplicate rows

### Monitoring
- [ ] Check Sentry, sync breadcrumbs visible for the session
- [ ] Check admin panel, sync health shows the test connection
- [ ] Check Pino logs, structured sync events present
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-staging.yml docs/quickbooks-sandbox-checklist.md
git commit -m "feat: add staging deploy workflow and sandbox checklist (QB-13)"
```

---

## Task 10: Intuit App Review Prep (QB-14)

**Files:**
- Create: `apps/web/app/privacy/page.tsx`
- Create: `apps/web/app/terms/page.tsx`

This task is content work, draft the privacy policy and terms of service pages that Intuit requires for app review.

- [ ] **Step 1: Create privacy policy page**

```tsx
// apps/web/app/privacy/page.tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy, Tellsight',
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold text-foreground">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: April 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-card-foreground">
        <section>
          <h2 className="text-base font-semibold text-foreground">What We Collect</h2>
          <p className="mt-2">
            When you connect QuickBooks, we read your transaction data (invoices,
            purchases, payments, bills, and related records). We store the date,
            amount, category, and a label for each transaction. We do not store
            customer names, addresses, tax IDs, or bank account numbers.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">How We Use It</h2>
          <p className="mt-2">
            Your transaction data is used to generate charts and AI-powered
            business insights. Raw transaction data is never sent to the AI
            model, only computed statistics (totals, averages, trends).
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">How We Store It</h2>
          <p className="mt-2">
            OAuth tokens are encrypted at rest using AES-256-GCM. Transaction
            data is stored in a PostgreSQL database with row-level security
            isolating each organization. All connections use TLS.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">How to Delete Your Data</h2>
          <p className="mt-2">
            Disconnect QuickBooks from Settings &rarr; Integrations at any time.
            This revokes our access to your QuickBooks account. To delete your
            stored transaction data, contact us or delete your Tellsight account.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">Third-Party Services</h2>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>Intuit QuickBooks, accounting data sync</li>
            <li>Anthropic Claude, AI-powered analysis (receives statistics only, not raw data)</li>
            <li>Stripe, payment processing</li>
            <li>Sentry, error monitoring (no user data in reports)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">Contact</h2>
          <p className="mt-2">
            Questions about privacy? Email privacy@tellsight.app.
          </p>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create terms of service page**

```tsx
// apps/web/app/terms/page.tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service, Tellsight',
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold text-foreground">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: April 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-card-foreground">
        <section>
          <h2 className="text-base font-semibold text-foreground">Service Description</h2>
          <p className="mt-2">
            Tellsight provides AI-powered analytics for small business financial
            data. You upload CSV files or connect accounting software, and we
            generate charts and plain-English summaries of your business trends.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">Your Data</h2>
          <p className="mt-2">
            You own your data. We process it to provide the service. We do not
            sell, share, or use your data for training AI models. You can delete
            your data at any time by disconnecting integrations and deleting
            your account.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">AI-Generated Content</h2>
          <p className="mt-2">
            AI summaries are generated analysis, not financial advice. They may
            contain errors. Do not make business decisions based solely on
            AI-generated insights without independent verification.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">Subscription and Billing</h2>
          <p className="mt-2">
            Free tier includes charts and a preview AI summary. Pro subscription
            ($29/month) unlocks full AI analysis, email digests, and priority
            support. Cancel anytime, access continues through the billing period.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground">Limitation of Liability</h2>
          <p className="mt-2">
            Tellsight is provided as-is. We are not liable for decisions made
            based on AI-generated analysis. Our liability is limited to the
            amount you paid for the service in the 12 months before the claim.
          </p>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add footer links to privacy and terms pages**

In the landing page footer (`apps/web/app/page.tsx`), add links:

```tsx
<div className="flex items-center gap-4 text-xs text-muted-foreground">
  <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
  <Link href="/terms" className="hover:text-foreground">Terms</Link>
</div>
```

- [ ] **Step 4: Type-check and lint**

Run: `pnpm -C apps/web type-check && pnpm -C apps/web lint`
Expected: Both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/privacy/ apps/web/app/terms/ apps/web/app/page.tsx
git commit -m "feat: add privacy policy and terms of service pages (QB-14)"
```

- [ ] **Step 6: Document remaining Intuit review prep (non-code)**

After the frontend stories ship, these manual steps remain:
1. Take 3-5 screenshots (OAuth consent, integrations page, dashboard with QB data)
2. Record 2-3 min demo video (connect → sync → dashboard → disconnect)
3. Submit app review on Intuit Developer Portal
4. Timeline: 2-4 weeks for initial review

---

## Summary

| Task | Story | Commits | What |
|------|-------|---------|------|
| 1 | QB-8 | 1 | Upload page QB card |
| 2-3 | QB-9 | 2 | Stale nudge (backend + frontend) |
| 4-5 | QB-10 | 2 | Sentry breadcrumbs + admin sync health panel |
| 6-7 | QB-11 | 2 | Integration tests (~35 Vitest tests) |
| 8 | QB-12 | 1 | Playwright E2E (25 tests) |
| 9 | QB-13 | 1 | Staging deploy workflow + sandbox checklist |
| 10 | QB-14 | 1 | Privacy policy, terms, Intuit review prep |
| **Total** | | **10 commits** | |
