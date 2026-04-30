# Dataset Management, Design Spec

**Date:** 2026-04-15
**Status:** Approved
**Scope:** Multi-dataset support with list, rename, delete, activate, and dashboard switching.

## Problem

Users can upload CSVs but have no way to see, manage, or switch between them. The dashboard always shows the newest dataset. Old uploads accumulate silently. There's no rename, no delete, no way to go back to a previous dataset.

## Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Multi-dataset model | Keep all uploads, user picks | Users upload different time periods, want to compare |
| Delete permissions | Org owners only | Destructive, cascades to rows, summaries, shares |
| Active dataset tracking | `active_dataset_id` on `orgs` + URL override | Simple, org-wide default, `?dataset=` for temporary switching |
| Switcher placement | Dedicated `/settings/datasets` page + dashboard header chip | Keeps dashboard focused, management has room to breathe |
| Delete active dataset | Auto-switch to next newest, empty state if none left | Graceful degradation |
| Rename | Inline edit on management page | No modal, click, type, Enter |

## Data Model

### Migration: add `active_dataset_id` to `orgs`

```sql
ALTER TABLE orgs
  ADD COLUMN active_dataset_id INTEGER
  REFERENCES datasets(id) ON DELETE SET NULL;
```

One column addition. No new tables.

**Behavior:**
- `NULL` = no explicit active dataset → dashboard falls back to newest, or empty state if none exist
- On new upload: `persistUpload` sets `active_dataset_id` to the newly created dataset
- On delete of active dataset: FK `ON DELETE SET NULL` nullifies it, API returns `newActiveDatasetId` (next newest or null)
- Seed datasets are excluded from management (auto-cleaned on first user upload, as before)

## API Design

All routes require authentication. Base path: `/datasets`.

### Routes

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/datasets` | Any member | List all datasets for the org |
| `GET` | `/datasets/:id` | Any member | Get single dataset with row count |
| `PATCH` | `/datasets/:id` | Any member | Rename a dataset |
| `DELETE` | `/datasets/:id` | Owner only | Delete dataset + cascades |
| `POST` | `/datasets/:id/activate` | Any member | Set as org's active dataset |

### Response Shapes

**List:**
```json
{
  "data": [
    {
      "id": 1,
      "name": "2024-2025 Financials",
      "rowCount": 144,
      "sourceType": "csv",
      "uploadedBy": { "id": 5, "name": "Corey" },
      "createdAt": "2025-01-15T...",
      "isActive": true
    }
  ]
}
```

**Single dataset (used before delete confirmation to show cascade counts):**
```json
{
  "data": {
    "id": 1,
    "name": "2024-2025 Financials",
    "rowCount": 144,
    "sourceType": "csv",
    "uploadedBy": { "id": 5, "name": "Corey" },
    "createdAt": "2025-01-15T...",
    "isActive": true,
    "summaryCount": 1,
    "shareCount": 2
  }
}
```

**Delete:**
```json
{
  "data": {
    "deleted": true,
    "newActiveDatasetId": 3
  }
}
```

`newActiveDatasetId` is `null` when no datasets remain.

### Dashboard Route Change

`GET /dashboard/charts` accepts optional `?dataset=123` query param:
- Present: validate dataset belongs to org, use it for chart computation
- Absent: use `org.active_dataset_id`, fall back to newest
- Invalid/wrong org: ignore, use default

Response shape unchanged, already includes `datasetId`.

### Validation Rules

- Rename: 1-255 chars, trimmed, reject empty/whitespace-only
- Delete: reject attempts on seed datasets (400), reject non-owners (403)
- Activate: reject datasets not belonging to the org (404)

### New Analytics Events

- `dataset.renamed`, `{ datasetId, oldName, newName }`
- `dataset.deleted`, `{ datasetId, rowCount, hadActiveShares }`
- `dataset.activated`, `{ datasetId, previousDatasetId }`

## Frontend

### New Pages & Components

**`/settings/datasets` page**, Dataset management

Components:
- `DatasetList`, server component fetches datasets, passes to client
- `DatasetCard`, individual row: name, row count, upload date, uploader, action buttons
- `RenameInline`, click-to-edit input, Enter saves, Escape cancels
- `DeleteConfirmation`, inline warning panel showing cascade impact (row count, summary count, share count), confirm/cancel buttons

**Dashboard header, `DatasetChip`**
- Small chip below org name: dataset icon + name + row count + chevron
- Clicking navigates to `/settings/datasets`
- Only rendered for authenticated users (demo mode keeps current layout unchanged)

**Sidebar update:**
- "Settings" becomes a section header
- Sub-items: Invites, Datasets

### UX Details

**Rename flow:**
1. Click "Rename" button on dataset card
2. Name becomes an editable input with current value
3. Enter or blur → PATCH call → optimistic update, revert on failure
4. Escape → cancel, restore original name

**Delete flow:**
1. Click "Delete" button (visible to owners only)
2. Inline confirmation panel expands below the card
3. Shows: "This will permanently remove {n} data rows, {n} AI summaries, and {n} share links."
4. "Yes, delete" → DELETE call → remove from list, redirect dashboard if active
5. "Cancel" → collapse panel

**Activate flow:**
1. Click "Set active" on an inactive dataset
2. POST call → update active badge, dashboard chip reflects new dataset
3. If user is on dashboard with no `?dataset=` param, it will show the new active dataset on next load

### RBAC Visibility

| Element | Owner | Member |
|---------|-------|--------|
| Dataset list | Yes | Yes |
| Rename button | Yes | Yes |
| Set active button | Yes | Yes |
| Delete button | Yes | No (hidden) |
| Dashboard chip | Yes | Yes |

## Error Handling

| Scenario | Response | Status |
|----------|----------|--------|
| Dataset not found | `NOT_FOUND` | 404 |
| Delete by non-owner | `FORBIDDEN` | 403 |
| Rename empty name | `VALIDATION_ERROR` | 400 |
| Activate wrong-org dataset | `NOT_FOUND` | 404 |
| Delete last dataset | Succeeds, `newActiveDatasetId: null` | 200 |
| Delete dataset with active shares | Succeeds with cascade, confirmation warns user | 200 |

**Frontend error handling:**
- Optimistic rename with revert on failure + toast
- Delete confirmation shows exact cascade impact before user commits
- Network failure → toast with retry
- Stale data (404 on action) → refetch list

**Edge cases:**
- Upload while on management page → list doesn't auto-refresh. Refetch on page focus via `visibilitychange` listener.
- Concurrent delete + activate race → `ON DELETE SET NULL` handles at DB level. API returns current state.
- Dataset with 0 rows → shown in list, deletable, displays "0 rows."

## Testing

### Backend (Vitest)

Extend `datasets.test.ts`:
- `GET /datasets`, list sorted newest-first, includes `isActive`, respects RLS
- `GET /datasets/:id`, returns dataset with row count, 404 for wrong org
- `PATCH /datasets/:id`, rename succeeds, empty name rejected, 404 for wrong org
- `DELETE /datasets/:id`, owner succeeds, member gets 403, cascades verified (rows + summaries + shares removed), active auto-switches to next newest
- `POST /datasets/:id/activate`, sets `active_dataset_id`, 404 for wrong org

Extend `dashboard.test.ts`:
- `?dataset=123` query param uses specified dataset
- `?dataset=999` (wrong org) falls back to active
- No active + no datasets → empty response

### Frontend (Vitest + jsdom)

- `DatasetList`, renders datasets, active badge, owner sees delete, member doesn't
- `DatasetCard`, rename inline edit flow, activate call
- `DeleteConfirmation`, shows cascade counts, fires delete on confirm
- `DatasetChip`, renders name + count, links to management page, hidden for unauthenticated

## Scope Boundaries

**In scope:**
- List, rename, delete, activate datasets
- Dashboard header chip
- `?dataset=` URL override
- Sidebar nav update
- Delete cascade warnings
- RBAC on delete

**Out of scope:**
- Multi-dataset comparison / overlay charts
- Dataset versioning / rollback
- Bulk delete
- Dataset archiving (soft delete)
- Per-user active dataset preferences
- CSV re-upload / append to existing dataset
- Dataset search / filtering (unnecessary until 10+ datasets)

## Files to Create or Modify

### New Files
- `apps/api/src/routes/datasetManagement.ts`, new routes (list, get, rename, delete, activate)
- `apps/api/src/routes/datasetManagement.test.ts`, API tests
- `apps/api/src/db/migrations/XXXX_add_active_dataset_id.ts`, Drizzle migration
- `apps/web/app/settings/datasets/page.tsx`, management page
- `apps/web/components/datasets/DatasetList.tsx`, list component
- `apps/web/components/datasets/DatasetCard.tsx`, individual card
- `apps/web/components/datasets/RenameInline.tsx`, inline edit
- `apps/web/components/datasets/DeleteConfirmation.tsx`, confirmation panel
- `apps/web/components/datasets/DatasetChip.tsx`, dashboard header chip
- `apps/web/components/datasets/DatasetChip.test.tsx`, chip tests
- `apps/web/components/datasets/DatasetList.test.tsx`, list tests

### Modified Files
- `apps/api/src/db/schema.ts`, add `activeDatasetId` to `orgs`
- `apps/api/src/db/queries/datasets.ts`, add `getDatasetById`, `deleteDataset`, `updateDatasetName`, `setActiveDataset`, `getDatasetCascadeCounts`
- `apps/api/src/routes/datasets.ts`, update `persistUpload` to set active dataset
- `apps/api/src/routes/dashboard.ts`, accept `?dataset=` param, use `active_dataset_id`
- `apps/api/src/routes/dashboard.test.ts`, extend with dataset switching tests
- `apps/web/app/dashboard/page.tsx`, pass `datasetId` and dataset info for chip
- `apps/web/components/Sidebar.tsx`, add Datasets link under Settings section
- `packages/shared/src/constants/index.ts`, add new analytics event names
