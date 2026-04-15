# Dataset Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-dataset support — users can list, rename, delete, activate datasets, and switch which one the dashboard displays.

**Architecture:** One new column on `orgs` (`active_dataset_id`), five new API routes on the existing `/datasets` router, a new `/settings/datasets` management page, and a clickable chip on the dashboard header. Dashboard route gains `?dataset=` query param support.

**Tech Stack:** Drizzle ORM (Postgres), Express 5, Next.js 16, Vitest, Tailwind CSS 4, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-04-15-dataset-management-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/api/drizzle/migrations/0015_add-active-dataset-id.sql` | Migration: add column + FK + index |
| `apps/api/src/routes/datasetManagement.ts` | Routes: list, get, rename, delete, activate |
| `apps/api/src/routes/datasetManagement.test.ts` | API tests for all 5 routes |
| `apps/web/app/settings/datasets/page.tsx` | Settings page wrapper |
| `apps/web/app/settings/datasets/DatasetManager.tsx` | Client component: list + all interactions |
| `apps/web/components/datasets/DatasetChip.tsx` | Dashboard header chip |

### Modified Files
| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `activeDatasetId` to `orgs` table + relation |
| `apps/api/src/db/queries/datasets.ts` | Add 5 new query functions |
| `apps/api/src/db/queries/orgs.ts` | Add `setActiveDataset` function |
| `apps/api/src/routes/protected.ts` | Mount new management router |
| `apps/api/src/routes/datasets.ts` | Update `persistUpload` confirm handler to set active |
| `apps/api/src/routes/dashboard.ts` | Accept `?dataset=` param, use `active_dataset_id` |
| `apps/api/src/routes/dashboard.test.ts` | Add dataset switching tests |
| `apps/web/app/dashboard/page.tsx` | Pass active dataset info for chip |
| `apps/web/components/layout/Sidebar.tsx` | Add Datasets link under Settings section |
| `packages/shared/src/constants/index.ts` | Add 3 new analytics event names |

---

## Task 1: Schema + Migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:30-36`
- Modify: `apps/api/src/db/schema.ts` (orgsRelations)
- Create: `apps/api/drizzle/migrations/0015_add-active-dataset-id.sql`

- [ ] **Step 1: Add `activeDatasetId` column to `orgs` table in schema**

In `apps/api/src/db/schema.ts`, add the column to the `orgs` table definition. The column goes after `businessProfile`:

```typescript
// In the orgs pgTable definition, add after businessProfile:
activeDatasetId: integer('active_dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
```

The full `orgs` table should look like:
```typescript
export const orgs = pgTable('orgs', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  slug: varchar({ length: 255 }).notNull().unique(),
  businessProfile: jsonb('business_profile'),
  activeDatasetId: integer('active_dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 2: Add relation to `orgsRelations`**

Find `orgsRelations` in the same file and add the `activeDataset` relation:

```typescript
export const orgsRelations = relations(orgs, ({ many, one }) => ({
  userOrgs: many(userOrgs),
  datasets: many(datasets),
  orgInvites: many(orgInvites),
  shares: many(shares),
  analyticsEvents: many(analyticsEvents),
  subscriptions: many(subscriptions),
  activeDataset: one(datasets, {
    fields: [orgs.activeDatasetId],
    references: [datasets.id],
  }),
}));
```

- [ ] **Step 3: Create the migration file**

Create `apps/api/drizzle/migrations/0015_add-active-dataset-id.sql`:

```sql
ALTER TABLE "orgs" ADD COLUMN "active_dataset_id" integer;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_active_dataset_id_datasets_id_fk" FOREIGN KEY ("active_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;
```

- [ ] **Step 4: Run type-check to verify schema compiles**

Run: `pnpm --filter api type-check`
Expected: PASS (0 errors)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/migrations/0015_add-active-dataset-id.sql
git commit -m "feat: add active_dataset_id column to orgs table"
```

---

## Task 2: Analytics Event Constants

**Files:**
- Modify: `packages/shared/src/constants/index.ts`

- [ ] **Step 1: Add new analytics event names**

In `packages/shared/src/constants/index.ts`, add three new entries to the `ANALYTICS_EVENTS` object, after `TRANSPARENCY_PANEL_OPENED`:

```typescript
DATASET_RENAMED: 'dataset.renamed',
DATASET_DELETED: 'dataset.deleted',
DATASET_ACTIVATED: 'dataset.activated',
```

- [ ] **Step 2: Run type-check**

Run: `pnpm --filter shared type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants/index.ts
git commit -m "feat: add dataset management analytics event constants"
```

---

## Task 3: Database Query Functions

**Files:**
- Modify: `apps/api/src/db/queries/datasets.ts`
- Modify: `apps/api/src/db/queries/orgs.ts`

- [ ] **Step 1: Add query functions to `datasets.ts`**

Add these functions to `apps/api/src/db/queries/datasets.ts`. Add `sql` to the drizzle-orm import:

```typescript
import { eq, and, desc, sql } from 'drizzle-orm';
```

Add these imports at the top alongside existing ones:

```typescript
import { orgs } from '../schema.js';
import { shares } from '../schema.js';
import { aiSummaries } from '../schema.js';
```

Then add the new functions after the existing `deleteSeedDatasets`:

```typescript
export async function getDatasetById(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.datasets.findFirst({
    where: and(eq(datasets.orgId, orgId), eq(datasets.id, datasetId)),
  });
}

export async function getDatasetWithCounts(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  const dataset = await client.query.datasets.findFirst({
    where: and(eq(datasets.orgId, orgId), eq(datasets.id, datasetId)),
  });
  if (!dataset) return null;

  const [rowCount] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(dataRows)
    .where(eq(dataRows.datasetId, datasetId));

  const [summaryCount] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(aiSummaries)
    .where(eq(aiSummaries.datasetId, datasetId));

  const [shareCount] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(shares)
    .where(eq(shares.datasetId, datasetId));

  return {
    ...dataset,
    rowCount: rowCount?.count ?? 0,
    summaryCount: summaryCount?.count ?? 0,
    shareCount: shareCount?.count ?? 0,
  };
}

export async function getDatasetListWithCounts(
  orgId: number,
  activeDatasetId: number | null,
  client: typeof db | DbTransaction = db,
) {
  const allDatasets = await client.query.datasets.findMany({
    where: and(eq(datasets.orgId, orgId), eq(datasets.isSeedData, false)),
    orderBy: desc(datasets.createdAt),
    with: { uploadedByUser: true },
  });

  const results = [];
  for (const ds of allDatasets) {
    const [rowCount] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(dataRows)
      .where(eq(dataRows.datasetId, ds.id));

    results.push({
      id: ds.id,
      name: ds.name,
      sourceType: ds.sourceType,
      createdAt: ds.createdAt,
      uploadedBy: ds.uploadedByUser
        ? { id: ds.uploadedByUser.id, name: ds.uploadedByUser.name }
        : null,
      rowCount: rowCount?.count ?? 0,
      isActive: ds.id === activeDatasetId,
    });
  }

  return results;
}

export async function updateDatasetName(
  orgId: number,
  datasetId: number,
  name: string,
  client: typeof db | DbTransaction = db,
) {
  const [updated] = await client
    .update(datasets)
    .set({ name })
    .where(and(eq(datasets.id, datasetId), eq(datasets.orgId, orgId)))
    .returning();
  return updated ?? null;
}

export async function deleteDataset(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  const deleted = await client
    .delete(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.orgId, orgId), eq(datasets.isSeedData, false)))
    .returning({ id: datasets.id });
  return deleted.length > 0;
}
```

Note: the `getDatasetListWithCounts` uses a `with: { uploadedByUser: true }` relation. Check if the `datasetsRelations` includes this. If the relation is named differently, use the existing name. The `datasets` relation to `users` is via `uploadedBy` FK.

- [ ] **Step 2: Add `dataRows` import for count queries**

Add import at the top of `datasets.ts`:

```typescript
import { dataRows } from '../schema.js';
```

Consolidate schema imports into a single line:

```typescript
import { datasets, dataRows, orgs, aiSummaries, shares } from '../schema.js';
```

- [ ] **Step 3: Check datasets relations for uploadedBy user**

Read `apps/api/src/db/schema.ts` and find `datasetsRelations`. If there's no relation to `users` via `uploadedBy`, add one. If it exists, note the relation name for the `with:` clause in `getDatasetListWithCounts`.

If the relation doesn't exist, add it:

```typescript
// In datasetsRelations:
uploadedByUser: one(users, {
  fields: [datasets.uploadedBy],
  references: [users.id],
}),
```

- [ ] **Step 4: Add `setActiveDataset` to `orgs.ts`**

In `apps/api/src/db/queries/orgs.ts`, add:

```typescript
import type { DbTransaction } from '../../lib/db.js';
```

Update the existing `db` import to:

```typescript
import { db, type DbTransaction } from '../../lib/db.js';
```

Then add the function:

```typescript
export async function setActiveDataset(
  orgId: number,
  datasetId: number | null,
  client: typeof db | DbTransaction = db,
) {
  const [updated] = await client
    .update(orgs)
    .set({ activeDatasetId: datasetId })
    .where(eq(orgs.id, orgId))
    .returning();
  return updated ?? null;
}

export async function getActiveDatasetId(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<number | null> {
  const org = await client.query.orgs.findFirst({
    where: eq(orgs.id, orgId),
    columns: { activeDatasetId: true },
  });
  return org?.activeDatasetId ?? null;
}
```

- [ ] **Step 5: Run type-check**

Run: `pnpm --filter api type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/queries/datasets.ts apps/api/src/db/queries/orgs.ts apps/api/src/db/schema.ts
git commit -m "feat: add dataset management query functions"
```

---

## Task 4: Management API Routes

**Files:**
- Create: `apps/api/src/routes/datasetManagement.ts`
- Modify: `apps/api/src/routes/protected.ts`

- [ ] **Step 1: Create the management routes file**

Create `apps/api/src/routes/datasetManagement.ts`:

```typescript
import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { datasetsQueries, orgsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../lib/logger.js';

export const datasetManagementRouter = Router();

datasetManagementRouter.get('/manage', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const orgId = user.org_id;

  const activeDatasetId = await orgsQueries.getActiveDatasetId(orgId);
  const datasets = await withRlsContext(orgId, user.isAdmin, (tx) =>
    datasetsQueries.getDatasetListWithCounts(orgId, activeDatasetId, tx),
  );

  res.json({ data: datasets });
});

datasetManagementRouter.get('/manage/:id', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const orgId = user.org_id;
  const datasetId = parseInt(req.params.id, 10);

  if (isNaN(datasetId) || datasetId < 1) {
    throw new ValidationError('Invalid dataset ID');
  }

  const dataset = await withRlsContext(orgId, user.isAdmin, (tx) =>
    datasetsQueries.getDatasetWithCounts(orgId, datasetId, tx),
  );

  if (!dataset) throw new NotFoundError('Dataset not found');

  const activeDatasetId = await orgsQueries.getActiveDatasetId(orgId);

  res.json({
    data: {
      ...dataset,
      isActive: dataset.id === activeDatasetId,
    },
  });
});

datasetManagementRouter.patch('/manage/:id', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const orgId = user.org_id;
  const userId = parseInt(user.sub, 10);
  const datasetId = parseInt(req.params.id, 10);

  if (isNaN(datasetId) || datasetId < 1) {
    throw new ValidationError('Invalid dataset ID');
  }

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 255) {
    throw new ValidationError('Name must be 1–255 characters');
  }

  const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
    datasetsQueries.getDatasetById(orgId, datasetId, tx),
  );
  if (!existing) throw new NotFoundError('Dataset not found');

  const oldName = existing.name;

  const updated = await withRlsContext(orgId, user.isAdmin, (tx) =>
    datasetsQueries.updateDatasetName(orgId, datasetId, name, tx),
  );

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_RENAMED, {
    datasetId,
    oldName,
    newName: name,
  });

  logger.info({ orgId, datasetId, oldName, newName: name }, 'dataset renamed');

  res.json({ data: updated });
});

datasetManagementRouter.delete(
  '/manage/:id',
  roleGuard('owner'),
  async (req, res: Response) => {
    const { user } = req as AuthenticatedRequest;
    const orgId = user.org_id;
    const userId = parseInt(user.sub, 10);
    const datasetId = parseInt(req.params.id, 10);

    if (isNaN(datasetId) || datasetId < 1) {
      throw new ValidationError('Invalid dataset ID');
    }

    const existing = await withRlsContext(orgId, user.isAdmin, (tx) =>
      datasetsQueries.getDatasetWithCounts(orgId, datasetId, tx),
    );
    if (!existing) throw new NotFoundError('Dataset not found');

    const deleted = await withRlsContext(orgId, user.isAdmin, (tx) =>
      datasetsQueries.deleteDataset(orgId, datasetId, tx),
    );
    if (!deleted) throw new NotFoundError('Dataset not found');

    // ON DELETE SET NULL already cleared active_dataset_id if this was active.
    // Find the new active dataset (next newest) and set it.
    const activeDatasetId = await orgsQueries.getActiveDatasetId(orgId);
    let newActiveDatasetId: number | null = activeDatasetId;

    if (!activeDatasetId) {
      const remaining = await datasetsQueries.getDatasetsByOrg(orgId);
      const nextDataset = remaining.find((d) => !d.isSeedData);
      if (nextDataset) {
        await orgsQueries.setActiveDataset(orgId, nextDataset.id);
        newActiveDatasetId = nextDataset.id;
      }
    }

    trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_DELETED, {
      datasetId,
      rowCount: existing.rowCount,
      hadActiveShares: existing.shareCount > 0,
    });

    logger.info({ orgId, datasetId, rowCount: existing.rowCount }, 'dataset deleted');

    res.json({ data: { deleted: true, newActiveDatasetId } });
  },
);

datasetManagementRouter.post('/manage/:id/activate', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const orgId = user.org_id;
  const userId = parseInt(user.sub, 10);
  const datasetId = parseInt(req.params.id, 10);

  if (isNaN(datasetId) || datasetId < 1) {
    throw new ValidationError('Invalid dataset ID');
  }

  const dataset = await withRlsContext(orgId, user.isAdmin, (tx) =>
    datasetsQueries.getDatasetById(orgId, datasetId, tx),
  );
  if (!dataset) throw new NotFoundError('Dataset not found');

  const previousId = await orgsQueries.getActiveDatasetId(orgId);
  await orgsQueries.setActiveDataset(orgId, datasetId);

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_ACTIVATED, {
    datasetId,
    previousDatasetId: previousId,
  });

  logger.info({ orgId, datasetId, previousDatasetId: previousId }, 'dataset activated');

  res.json({ data: { activated: true, datasetId } });
});
```

- [ ] **Step 2: Mount the routes in `protected.ts`**

In `apps/api/src/routes/protected.ts`, add the import and mount:

```typescript
import { datasetManagementRouter } from './datasetManagement.js';
```

Mount it on the existing `/datasets` path (after the existing `datasetsRouter` mount):

```typescript
protectedRouter.use('/datasets', datasetManagementRouter);
```

The existing upload routes (`POST /datasets` and `POST /datasets/confirm`) won't conflict because the management routes use `/datasets/manage/*` paths.

- [ ] **Step 3: Run type-check**

Run: `pnpm --filter api type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/datasetManagement.ts apps/api/src/routes/protected.ts
git commit -m "feat: add dataset management API routes"
```

---

## Task 5: Update Upload to Set Active Dataset

**Files:**
- Modify: `apps/api/src/routes/datasets.ts:212-269` (confirm handler)

- [ ] **Step 1: Import `orgsQueries`**

At the top of `apps/api/src/routes/datasets.ts`, add:

```typescript
import { orgsQueries } from '../db/queries/index.js';
```

- [ ] **Step 2: Set active dataset after persist**

In the confirm handler (the `datasetsRouter.post('/confirm', ...)` route), after `persistUpload` returns and before the `trackEvent` call, add:

```typescript
await orgsQueries.setActiveDataset(orgId, result.datasetId);
```

- [ ] **Step 3: Run type-check**

Run: `pnpm --filter api type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/datasets.ts
git commit -m "feat: set active dataset on upload confirm"
```

---

## Task 6: Dashboard Route — Dataset Switching

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts`

- [ ] **Step 1: Read the current dashboard route**

Read `apps/api/src/routes/dashboard.ts` fully to understand the current flow. The authenticated path (around lines 47-90) calls `getDatasetsByOrg` and uses `datasets[0]?.id`. We need to change this to:

1. Check for `?dataset=` query param
2. If present, validate it belongs to the org and use it
3. If absent, check `org.active_dataset_id`
4. If null, fall back to newest dataset

- [ ] **Step 2: Add import for `orgsQueries`**

At the top, ensure `orgsQueries` is imported:

```typescript
import { orgsQueries } from '../db/queries/index.js';
```

Also import `getDatasetById` from datasets queries if not already available through the barrel.

- [ ] **Step 3: Update the authenticated code path**

Replace the dataset selection logic in the authenticated path. Find where `datasets[0]?.id` is used and replace the dataset selection with:

```typescript
// Resolve which dataset to show
const queryDatasetId = req.query.dataset ? parseInt(req.query.dataset as string, 10) : null;
let datasetId: number | null = null;

if (queryDatasetId && !isNaN(queryDatasetId)) {
  // URL override — validate it belongs to this org
  const found = datasets.find((d) => d.id === queryDatasetId);
  if (found) datasetId = found.id;
}

if (!datasetId) {
  // Check org's active dataset
  const activeId = await orgsQueries.getActiveDatasetId(orgId);
  if (activeId) {
    const found = datasets.find((d) => d.id === activeId);
    if (found) datasetId = found.id;
  }
}

if (!datasetId) {
  // Fall back to newest
  datasetId = datasets[0]?.id ?? null;
}
```

- [ ] **Step 4: Also pass `activeDatasetId` in response**

Add `activeDatasetId` to the response data object so the frontend chip knows which dataset is the org default:

```typescript
const activeDatasetId = await orgsQueries.getActiveDatasetId(orgId);
```

Include in the response: `activeDatasetId`.

- [ ] **Step 5: Run type-check**

Run: `pnpm --filter api type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard.ts
git commit -m "feat: dashboard supports dataset switching via query param and active_dataset_id"
```

---

## Task 7: Backend Tests — Management Routes

**Files:**
- Create: `apps/api/src/routes/datasetManagement.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/api/src/routes/datasetManagement.test.ts`. Follow the exact mocking pattern from `dashboard.test.ts` — all mocks before imports:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyAccessToken = vi.fn();
vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

const mockGetDatasetListWithCounts = vi.fn();
const mockGetDatasetWithCounts = vi.fn();
const mockGetDatasetById = vi.fn();
const mockUpdateDatasetName = vi.fn();
const mockDeleteDataset = vi.fn();
const mockGetDatasetsByOrg = vi.fn();

const mockGetActiveDatasetId = vi.fn();
const mockSetActiveDataset = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  datasetsQueries: {
    getDatasetListWithCounts: mockGetDatasetListWithCounts,
    getDatasetWithCounts: mockGetDatasetWithCounts,
    getDatasetById: mockGetDatasetById,
    updateDatasetName: mockUpdateDatasetName,
    deleteDataset: mockDeleteDataset,
    getDatasetsByOrg: mockGetDatasetsByOrg,
  },
  orgsQueries: {
    getActiveDatasetId: mockGetActiveDatasetId,
    setActiveDataset: mockSetActiveDataset,
  },
}));

const mockWithRlsContext = vi.fn();
vi.mock('../lib/rls.js', () => ({
  withRlsContext: (...args: unknown[]) => {
    const fn = args[2] as (tx: unknown) => unknown;
    return mockWithRlsContext(...args) ?? fn('mock-tx');
  },
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { datasetManagementRouter } = await import('./datasetManagement.js');

const ownerPayload = { sub: '1', org_id: 1, role: 'owner' as const, isAdmin: false, iat: 0, exp: 0 };
const memberPayload = { sub: '2', org_id: 1, role: 'member' as const, isAdmin: false, iat: 0, exp: 0 };

function setupApp() {
  const app = createTestApp();
  app.use('/datasets', datasetManagementRouter);
  return app;
}

const request = (await import('supertest')).default;

describe('dataset management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithRlsContext.mockImplementation((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => unknown) => fn('mock-tx'));
  });

  describe('GET /datasets/manage', () => {
    it('returns dataset list for authenticated user', async () => {
      mockVerifyAccessToken.mockResolvedValue(ownerPayload);
      mockGetActiveDatasetId.mockResolvedValue(1);
      mockGetDatasetListWithCounts.mockResolvedValue([
        { id: 1, name: 'Test Dataset', rowCount: 50, isActive: true, createdAt: new Date().toISOString(), uploadedBy: null, sourceType: 'csv' },
      ]);

      const app = setupApp();
      const res = await request(app)
        .get('/datasets/manage')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].isActive).toBe(true);
    });
  });

  describe('GET /datasets/manage/:id', () => {
    it('returns dataset with cascade counts', async () => {
      mockVerifyAccessToken.mockResolvedValue(ownerPayload);
      mockGetDatasetWithCounts.mockResolvedValue({
        id: 1, name: 'Test', rowCount: 50, summaryCount: 1, shareCount: 2,
      });
      mockGetActiveDatasetId.mockResolvedValue(1);

      const app = setupApp();
      const res = await request(app)
        .get('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.summaryCount).toBe(1);
      expect(res.body.data.shareCount).toBe(2);
    });

    it('returns 404 for nonexistent dataset', async () => {
      mockVerifyAccessToken.mockResolvedValue(ownerPayload);
      mockGetDatasetWithCounts.mockResolvedValue(null);

      const app = setupApp();
      const res = await request(app)
        .get('/datasets/manage/999')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /datasets/manage/:id', () => {
    it('renames a dataset', async () => {
      mockVerifyAccessToken.mockResolvedValue(memberPayload);
      mockGetDatasetById.mockResolvedValue({ id: 1, name: 'Old Name', orgId: 1 });
      mockUpdateDatasetName.mockResolvedValue({ id: 1, name: 'New Name' });

      const app = setupApp();
      const res = await request(app)
        .patch('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token')
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('New Name');
    });

    it('rejects empty name', async () => {
      mockVerifyAccessToken.mockResolvedValue(memberPayload);

      const app = setupApp();
      const res = await request(app)
        .patch('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token')
        .send({ name: '   ' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /datasets/manage/:id', () => {
    it('allows owner to delete', async () => {
      mockVerifyAccessToken.mockResolvedValue(ownerPayload);
      mockGetDatasetWithCounts.mockResolvedValue({ id: 1, rowCount: 50, shareCount: 0, summaryCount: 1 });
      mockDeleteDataset.mockResolvedValue(true);
      mockGetActiveDatasetId.mockResolvedValue(null);
      mockGetDatasetsByOrg.mockResolvedValue([]);

      const app = setupApp();
      const res = await request(app)
        .delete('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(res.body.data.newActiveDatasetId).toBeNull();
    });

    it('rejects member delete with 403', async () => {
      mockVerifyAccessToken.mockResolvedValue(memberPayload);

      const app = setupApp();
      const res = await request(app)
        .delete('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(403);
    });

    it('auto-switches active to next newest after delete', async () => {
      mockVerifyAccessToken.mockResolvedValue(ownerPayload);
      mockGetDatasetWithCounts.mockResolvedValue({ id: 1, rowCount: 50, shareCount: 0, summaryCount: 0 });
      mockDeleteDataset.mockResolvedValue(true);
      mockGetActiveDatasetId.mockResolvedValue(null);
      mockGetDatasetsByOrg.mockResolvedValue([{ id: 2, isSeedData: false }]);
      mockSetActiveDataset.mockResolvedValue({});

      const app = setupApp();
      const res = await request(app)
        .delete('/datasets/manage/1')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.newActiveDatasetId).toBe(2);
      expect(mockSetActiveDataset).toHaveBeenCalledWith(1, 2);
    });
  });

  describe('POST /datasets/manage/:id/activate', () => {
    it('activates a dataset', async () => {
      mockVerifyAccessToken.mockResolvedValue(memberPayload);
      mockGetDatasetById.mockResolvedValue({ id: 2, orgId: 1 });
      mockGetActiveDatasetId.mockResolvedValue(1);
      mockSetActiveDataset.mockResolvedValue({});

      const app = setupApp();
      const res = await request(app)
        .post('/datasets/manage/2/activate')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.activated).toBe(true);
    });

    it('returns 404 for dataset in another org', async () => {
      mockVerifyAccessToken.mockResolvedValue(memberPayload);
      mockGetDatasetById.mockResolvedValue(null);

      const app = setupApp();
      const res = await request(app)
        .post('/datasets/manage/999/activate')
        .set('Cookie', 'access_token=valid-token');

      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter api test -- --run src/routes/datasetManagement.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/datasetManagement.test.ts
git commit -m "test: add dataset management route tests"
```

---

## Task 8: Dashboard Test — Dataset Switching

**Files:**
- Modify: `apps/api/src/routes/dashboard.test.ts`

- [ ] **Step 1: Add dataset switching tests**

Add a new `describe` block to the existing dashboard test file for the `?dataset=` query param behavior. The exact mock setup depends on what's already mocked — follow the existing pattern. Add these test cases:

```typescript
describe('dataset query param', () => {
  it('uses ?dataset= param when valid', async () => {
    mockVerifyAccessToken.mockResolvedValue(ownerPayload);
    mockGetDatasetsByOrg.mockResolvedValue([
      { id: 1, isSeedData: false },
      { id: 2, isSeedData: false },
    ]);
    // mock getActiveDatasetId if added
    // mock getChartData to capture which datasetId was used
    mockGetChartData.mockResolvedValue(chartFixture);

    const app = setupApp();
    const res = await request(app)
      .get('/dashboard/charts?dataset=2')
      .set('Cookie', 'access_token=valid-token');

    expect(res.status).toBe(200);
    expect(res.body.data.datasetId).toBe(2);
  });

  it('ignores invalid ?dataset= param and falls back', async () => {
    mockVerifyAccessToken.mockResolvedValue(ownerPayload);
    mockGetDatasetsByOrg.mockResolvedValue([{ id: 1, isSeedData: false }]);
    mockGetChartData.mockResolvedValue(chartFixture);

    const app = setupApp();
    const res = await request(app)
      .get('/dashboard/charts?dataset=abc')
      .set('Cookie', 'access_token=valid-token');

    expect(res.status).toBe(200);
    expect(res.body.data.datasetId).toBe(1);
  });
});
```

- [ ] **Step 2: Run dashboard tests**

Run: `pnpm --filter api test -- --run src/routes/dashboard.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/dashboard.test.ts
git commit -m "test: add dashboard dataset switching tests"
```

---

## Task 9: Frontend — Sidebar Update

**Files:**
- Modify: `apps/web/components/layout/Sidebar.tsx`

- [ ] **Step 1: Update NAV_ITEMS to split Settings into a section**

In `apps/web/components/layout/Sidebar.tsx`, find the `NAV_ITEMS` constant. Replace the single Settings item with a section pattern. Import the `Database` icon from lucide-react:

```typescript
import { LayoutDashboard, Upload, Settings, ShieldCheck, Activity, X, Database, Users } from 'lucide-react';
```

Replace the `NAV_ITEMS` array:

```typescript
const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/upload', label: 'Upload', icon: Upload },
] as const;

const SETTINGS_ITEMS = [
  { href: '/settings/invites', label: 'Invites', icon: Users },
  { href: '/settings/datasets', label: 'Datasets', icon: Database },
] as const;
```

- [ ] **Step 2: Render the settings section in the nav**

In the `SidebarNav` component, after the `NAV_ITEMS.map(...)` block, add the settings section:

```tsx
<div className="mt-4 pt-4 border-t border-border">
  <p className="px-3 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settings</p>
  {SETTINGS_ITEMS.map(({ href, label, icon: Icon }) => {
    const isActive = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link key={href} href={href} onClick={onNavigate}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'border-l-4 border-primary bg-accent text-foreground'
            : 'border-l-4 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        aria-current={isActive ? 'page' : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {label}
      </Link>
    );
  })}
</div>
```

Remove the old Settings entry from `NAV_ITEMS` if it existed.

- [ ] **Step 3: Run type-check**

Run: `pnpm --filter web type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/layout/Sidebar.tsx
git commit -m "feat: add Datasets link to sidebar under Settings section"
```

---

## Task 10: Frontend — Dataset Management Page

**Files:**
- Create: `apps/web/app/settings/datasets/page.tsx`
- Create: `apps/web/app/settings/datasets/DatasetManager.tsx`

- [ ] **Step 1: Create the page wrapper**

Create `apps/web/app/settings/datasets/page.tsx`:

```typescript
import type { Metadata } from 'next';
import DatasetManager from './DatasetManager';

export const metadata: Metadata = {
  title: 'Datasets — Tellsight',
};

export default function DatasetsPage() {
  return <DatasetManager />;
}
```

- [ ] **Step 2: Create the DatasetManager client component**

Create `apps/web/app/settings/datasets/DatasetManager.tsx`:

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Database, Check, Pencil, Trash2, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface DatasetItem {
  id: number;
  name: string;
  rowCount: number;
  sourceType: string;
  uploadedBy: { id: number; name: string } | null;
  createdAt: string;
  isActive: boolean;
}

interface DatasetDetail extends DatasetItem {
  summaryCount: number;
  shareCount: number;
}

export default function DatasetManager() {
  const router = useRouter();
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteDetail, setDeleteDetail] = useState<DatasetDetail | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadDatasets = useCallback(async () => {
    try {
      const { data } = await apiClient<DatasetItem[]>('/datasets/manage');
      setDatasets(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load datasets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDatasets();
  }, [loadDatasets]);

  useEffect(() => {
    const onFocus = () => loadDatasets();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onFocus();
    });
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [loadDatasets]);

  async function handleActivate(id: number) {
    setActionLoading(true);
    try {
      await apiClient('/datasets/manage/' + id + '/activate', { method: 'POST' });
      setDatasets((prev) =>
        prev.map((d) => ({ ...d, isActive: d.id === id })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate dataset');
    } finally {
      setActionLoading(false);
    }
  }

  function startRename(dataset: DatasetItem) {
    setRenamingId(dataset.id);
    setRenameValue(dataset.name);
  }

  async function submitRename(id: number) {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setActionLoading(true);
    const prev = datasets.find((d) => d.id === id);
    setDatasets((ds) => ds.map((d) => (d.id === id ? { ...d, name: trimmed } : d)));
    setRenamingId(null);
    try {
      await apiClient('/datasets/manage/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
    } catch (err) {
      if (prev) setDatasets((ds) => ds.map((d) => (d.id === id ? { ...d, name: prev.name } : d)));
      setError(err instanceof Error ? err.message : 'Failed to rename');
    } finally {
      setActionLoading(false);
    }
  }

  async function startDelete(id: number) {
    setDeletingId(id);
    try {
      const { data } = await apiClient<DatasetDetail>('/datasets/manage/' + id);
      setDeleteDetail(data);
    } catch {
      setDeletingId(null);
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    setActionLoading(true);
    try {
      await apiClient('/datasets/manage/' + deletingId, { method: 'DELETE' });
      setDatasets((prev) => prev.filter((d) => d.id !== deletingId));
      setDeletingId(null);
      setDeleteDetail(null);
      await loadDatasets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-foreground">Datasets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your uploaded data. {datasets.length} dataset{datasets.length !== 1 ? 's' : ''}.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {datasets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Database className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">No datasets yet. Upload a CSV to get started.</p>
          <button
            onClick={() => router.push('/upload')}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Upload a CSV
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {datasets.map((dataset) => (
            <div
              key={dataset.id}
              className={`rounded-lg border p-4 transition-colors ${
                dataset.isActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  dataset.isActive ? 'bg-primary/10' : 'bg-muted'
                }`}>
                  <Database className={`h-5 w-5 ${dataset.isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>

                <div className="min-w-0 flex-1">
                  {renamingId === dataset.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(dataset.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => submitRename(dataset.id)}
                      className="w-full rounded-md border-2 border-primary bg-background px-2 py-1 text-sm font-medium text-foreground outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{dataset.name}</span>
                      {dataset.isActive && (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                          Active
                        </span>
                      )}
                    </div>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {dataset.rowCount} rows · Uploaded {new Date(dataset.createdAt).toLocaleDateString()}
                    {dataset.uploadedBy ? ` by ${dataset.uploadedBy.name}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  {!dataset.isActive && (
                    <button
                      onClick={() => handleActivate(dataset.id)}
                      disabled={actionLoading}
                      className="flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                      <Check className="h-3 w-3" />
                      Set active
                    </button>
                  )}
                  <button
                    onClick={() => startRename(dataset)}
                    disabled={actionLoading}
                    className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                  >
                    <Pencil className="h-3 w-3" />
                    Rename
                  </button>
                  <button
                    onClick={() => startDelete(dataset.id)}
                    disabled={actionLoading}
                    className="flex items-center gap-1.5 rounded-md border border-destructive/50 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                </div>
              </div>

              {deletingId === dataset.id && deleteDetail && (
                <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm font-medium text-destructive">Delete "{dataset.name}"?</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This will permanently remove {deleteDetail.rowCount} data row{deleteDetail.rowCount !== 1 ? 's' : ''}
                    {deleteDetail.summaryCount > 0 && `, ${deleteDetail.summaryCount} AI summar${deleteDetail.summaryCount !== 1 ? 'ies' : 'y'}`}
                    {deleteDetail.shareCount > 0 && `, and ${deleteDetail.shareCount} share link${deleteDetail.shareCount !== 1 ? 's' : ''}`}.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={confirmDelete}
                      disabled={actionLoading}
                      className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    >
                      {actionLoading ? 'Deleting...' : 'Yes, delete'}
                    </button>
                    <button
                      onClick={() => { setDeletingId(null); setDeleteDetail(null); }}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note: The delete button visibility should be conditional on the user's role. Since the client component doesn't have direct access to the JWT role, the simplest approach is to let the API return 403 and handle it gracefully. Alternatively, pass `isOwner` as a prop from the server component. For now, show the button to everyone and handle 403 on the client — the API enforces the real authorization.

- [ ] **Step 3: Run type-check**

Run: `pnpm --filter web type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/settings/datasets/page.tsx apps/web/app/settings/datasets/DatasetManager.tsx
git commit -m "feat: add dataset management page"
```

---

## Task 11: Frontend — Dashboard Chip

**Files:**
- Create: `apps/web/components/datasets/DatasetChip.tsx`
- Modify: `apps/web/app/dashboard/page.tsx`

- [ ] **Step 1: Create the DatasetChip component**

Create `apps/web/components/datasets/DatasetChip.tsx`:

```typescript
import Link from 'next/link';
import { Database, ChevronDown } from 'lucide-react';

interface DatasetChipProps {
  name: string;
  rowCount: number;
}

export function DatasetChip({ name, rowCount }: DatasetChipProps) {
  return (
    <Link
      href="/settings/datasets"
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs transition-colors hover:bg-accent"
    >
      <Database className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium text-foreground">{name}</span>
      <span className="text-muted-foreground">· {rowCount} rows</span>
      <ChevronDown className="h-3 w-3 text-muted-foreground" />
    </Link>
  );
}
```

- [ ] **Step 2: Add chip to dashboard page**

Read `apps/web/app/dashboard/page.tsx` to find where the org name is rendered. The `DashboardShell` component likely receives props. Add `activeDatasetName` and `activeDatasetRowCount` to the data passed down.

In `page.tsx`, the chart data response already includes `datasetId`. The dashboard route now also returns `activeDatasetId`. Fetch the active dataset name from the response and pass it to a `DatasetChip` rendered in the header area.

The exact integration depends on how `DashboardShell.tsx` structures its header. Find where the org name (`data.orgName`) is rendered and add the chip below it:

```tsx
import { DatasetChip } from '@/components/datasets/DatasetChip';

// In the JSX, after the org name:
{hasAuth && data.datasetId && (
  <DatasetChip
    name={data.datasetName ?? 'Untitled'}
    rowCount={data.rowCount ?? 0}
  />
)}
```

The backend needs to include `datasetName` and `rowCount` in the chart response. Add those fields to the dashboard route response in the backend (if not already done in Task 6, add them there).

- [ ] **Step 3: Run type-check**

Run: `pnpm --filter web type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/datasets/DatasetChip.tsx apps/web/app/dashboard/page.tsx
git commit -m "feat: add dataset chip to dashboard header"
```

---

## Task 12: BFF Proxy Routes

**Files:**
- Create: `apps/web/app/api/datasets/manage/route.ts`
- Create: `apps/web/app/api/datasets/manage/[id]/route.ts`
- Create: `apps/web/app/api/datasets/manage/[id]/activate/route.ts`

The existing Next.js rewrite in `next.config.ts` forwards `/api/:path*` to the Express API. However, cookie forwarding can be unreliable through rewrites. Check if the existing rewrite handles these new routes correctly. If it does, no BFF proxy files are needed.

- [ ] **Step 1: Verify the rewrite handles /api/datasets/manage**

Read `apps/web/next.config.ts` to check the rewrite rule. If it's a catch-all rewrite like:
```typescript
{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/:path*` }
```
Then it should forward `/api/datasets/manage` → `http://api:3001/datasets/manage` automatically. Test this by starting the dev server and calling the endpoint.

If the rewrite works, skip the manual proxy files. If not (cookie issues), create explicit route handlers following the pattern in `apps/web/app/api/datasets/route.ts`.

- [ ] **Step 2: Commit if any proxy files were created**

```bash
git add apps/web/app/api/datasets/
git commit -m "feat: add BFF proxy routes for dataset management"
```

---

## Task 13: Run Migration + Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Apply the migration**

Run the migration against the Docker Postgres:

```bash
docker compose exec db psql -U app_admin -d analytics -f /dev/stdin < apps/api/drizzle/migrations/0015_add-active-dataset-id.sql
```

Or if using Drizzle's migration runner:

```bash
pnpm --filter api build && DATABASE_ADMIN_URL=postgresql://app_admin:app@localhost:5432/analytics node -e "import('./apps/api/dist/db/migrate.js')"
```

Verify the column exists:

```bash
docker compose exec db psql -U app_admin -d analytics -c "\d orgs"
```

Expected: `active_dataset_id` column present, nullable integer.

- [ ] **Step 2: Run the full test suite**

```bash
pnpm test
```

Expected: All tests PASS.

- [ ] **Step 3: Run type-check across monorepo**

```bash
pnpm type-check
```

Expected: All packages PASS.

- [ ] **Step 4: Start dev server and verify visually**

Start the full stack, navigate to `/settings/datasets`, verify:
- Page loads (empty state if no user datasets)
- Sidebar shows Datasets link under Settings
- Dashboard header shows chip with active dataset (when authenticated)

- [ ] **Step 5: Commit any fixes**

If any adjustments were needed, commit them.

```bash
git add -A
git commit -m "fix: integration adjustments for dataset management"
```
