# QuickBooks Integration, Design Spec

**Date:** 2026-04-15
**Status:** Approved
**Scope:** QuickBooks Online OAuth connection, full data sync with BullMQ job queue, normalized transaction ingestion, and management UI.

## Problem

Users currently get data into TellSight by uploading CSVs. Most small businesses already have their financial data in QuickBooks Online. Asking them to export, format, and upload a CSV is friction that kills adoption. A direct QuickBooks connection lets users onboard in two clicks and keeps their data fresh automatically.

## Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Tier gating | Available to all (free + pro) | QB connect is an easier onboarding path than CSV, don't gate it |
| Data pull scope | All available data, all types | Pull everything QB offers. Normalize transactions to `data_rows`, store rest in `metadata` jsonb. Avoids re-syncing history when future features need it. |
| Sync frequency | Daily auto (3am UTC) + manual refresh | Keeps data fresh without burning API quota. User can force-refresh anytime. |
| Date range | All available (no artificial limit) | QB Online holds ~7 years. Let the date range filter handle scoping. |
| Sync architecture | BullMQ (Redis-backed job queue) | Production-grade: retry, concurrency control, crash recovery, scheduling. Redis already running. |
| AI summary on sync | Mark stale + nudge | Avoids burning Claude credits on every daily sync. User sees "data updated, refresh insights?" banner. |
| Connect UI location | Upload page (shortcut) + Settings → Integrations (management) | Onboard where users look for data, manage where users look for settings. |
| Disconnect behavior | Keep data, delete connection | User keeps their `data_rows` and charts. Only the OAuth link is severed. |

## Data Model

### New table: `integration_connections`

```sql
CREATE TABLE integration_connections (
  id              INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider        VARCHAR(50) NOT NULL,
  provider_tenant_id VARCHAR(255) NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  encrypted_access_token  TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  scope           VARCHAR(500),
  last_synced_at  TIMESTAMPTZ,
  sync_status     VARCHAR(20) NOT NULL DEFAULT 'idle',
  sync_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, provider)
);
```

- `provider`: `'quickbooks'` for now, extensible for `'xero'`, `'square'` later
- `provider_tenant_id`: QuickBooks `realmId` (company identifier)
- `sync_status`: `'idle'` | `'syncing'` | `'error'`
- Token encryption: AES-256-GCM using `ENCRYPTION_KEY` from config
- One connection per org per provider (unique constraint)

### New table: `sync_jobs`

```sql
CREATE TABLE sync_jobs (
  id              INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id   INTEGER NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  trigger         VARCHAR(20) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  rows_synced     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `trigger`: `'initial'` | `'scheduled'` | `'manual'`
- `status`: `'queued'` | `'running'` | `'completed'` | `'failed'`
- Provides sync history for the UI and debugging

### Existing table usage (no schema changes)

- `data_rows.source_type`: `'quickbooks'` already in the enum
- `data_rows.parent_category`: maps to QB account type (`'Income'` or `'Expenses'`)
- `data_rows.metadata` jsonb: stores full QB transaction response (vendor, memo, doc number, QB account code, QB transaction ID)
- `datasets.source_type`: `'quickbooks'`, one dataset per QB connection

### Idempotency

Each QB transaction gets `metadata.qb_id` set to its QuickBooks transaction ID. On re-sync, upsert logic checks for existing rows with matching `qb_id` + `org_id`:
- If found and data differs: update amount/date/category
- If found and identical: skip
- If not found: insert

### Token encryption

- Algorithm: AES-256-GCM
- Key: `ENCRYPTION_KEY` in config.ts (32-byte hex string)
- Each token gets a unique IV (stored alongside ciphertext as `iv:authTag:ciphertext` in the column)
- Decrypt only when making QB API calls, never expose plaintext tokens in logs or responses

## OAuth Flow

### Connect

1. User clicks "Connect QuickBooks" on Upload page or Settings → Integrations
2. Frontend calls `POST /api/integrations/quickbooks/connect`
3. Backend generates cryptographic state token, stores in httpOnly cookie (`qb_oauth_state`, 10-min TTL)
4. Backend returns `{ data: { authUrl: "https://appcenter.intuit.com/connect/oauth2?..." } }`
5. Frontend redirects browser to `authUrl`
6. User authorizes on Intuit's consent screen
7. Intuit redirects to `GET /integrations/quickbooks/callback?code=...&realmId=...&state=...`
8. Backend validates state token against cookie (CSRF protection)
9. Backend exchanges code for access + refresh tokens (server-to-server POST to Intuit token endpoint)
10. Encrypt tokens, create `integration_connections` row
11. Enqueue `initial-sync` job via BullMQ
12. Redirect to `/dashboard` (frontend shows "QuickBooks connected, syncing your data" toast via query param)

### Token refresh

Before any QB API call:
1. Check `access_token_expires_at`, if > 5 minutes remaining, proceed
2. If expired or near-expiry: decrypt refresh token, call Intuit token endpoint
3. Intuit returns new access + refresh tokens (both rotate)
4. Re-encrypt, update `integration_connections` row
5. Proceed with API call using fresh access token

If refresh fails (401, token revoked by user in QuickBooks):
1. Set `sync_status: 'error'`, `sync_error: 'QuickBooks access was revoked, please reconnect'`
2. UI shows reconnect prompt on next load

### Disconnect

1. User clicks "Disconnect" in Settings → Integrations
2. `DELETE /api/integrations/quickbooks`
3. Best-effort revoke at Intuit's endpoint (fire-and-forget)
4. Delete `integration_connections` row (cascades to `sync_jobs`)
5. Remove BullMQ repeatable job for this org
6. Datasets with `source_type: 'quickbooks'` remain, user keeps their historical data
7. Track `integration.disconnected` analytics event

### Config additions (config.ts)

```
QUICKBOOKS_CLIENT_ID     , Intuit developer app client ID
QUICKBOOKS_CLIENT_SECRET , Intuit developer app client secret
QUICKBOOKS_REDIRECT_URI  , callback URL (e.g., https://app.tellsight.com/integrations/quickbooks/callback)
QUICKBOOKS_ENVIRONMENT   , 'sandbox' | 'production'
ENCRYPTION_KEY           , 32-byte hex for AES-256-GCM token encryption
```

## Sync Architecture

### BullMQ setup

- **Queue name:** `quickbooks-sync`
- **Worker:** runs in the API process (same Node.js runtime, separate BullMQ worker)
- **Concurrency:** 2 (max 2 syncs running simultaneously across all orgs)
- **Connection:** reuses existing Redis from config

### Job types

| Job | Trigger | Behavior |
|-----|---------|----------|
| `initial-sync` | OAuth connect completes | Pull all data from QB, no date filter |
| `scheduled-sync` | BullMQ repeatable (daily 3am UTC) | Incremental: only rows updated since `last_synced_at` |
| `manual-sync` | User clicks "Refresh now" | Same as scheduled but on-demand |

### Sync pipeline (shared by all job types)

1. **Update status**, set `integration_connections.sync_status = 'syncing'`, create `sync_jobs` row
2. **Refresh token** if needed (see OAuth section)
3. **Fetch from QB API**, paginated, 1000 items per request:
   - Transaction types: Purchase, Invoice, Payment, SalesReceipt, Bill, BillPayment, JournalEntry, Deposit, Transfer, Estimate, CreditMemo, RefundReceipt, VendorCredit
   - For initial sync: `SELECT * FROM {TransactionType}`
   - For incremental: `SELECT * FROM {TransactionType} WHERE MetaData.LastUpdatedTime > '{last_synced_at}'`
   - Also fetch Chart of Accounts for category mapping
4. **Normalize** each transaction to `data_rows` shape:
   - `date` ← `TxnDate`
   - `amount` ← line item `Amount` (absolute value)
   - `category` ← QB account name from line item's `AccountRef`
   - `parent_category` ← `'Income'` if account classification is Revenue/Income, `'Expenses'` otherwise
   - `label` ← vendor/customer name or memo
   - `metadata` ← full QB transaction JSON including `qb_id`, `TxnType`, `DocNumber`, `PrivateNote`, etc.
   - `source_type` ← `'quickbooks'`
5. **Upsert**, batch insert/update using QB transaction ID as idempotency key
6. **Update dataset**, create dataset `"QuickBooks, {company_name}"` on initial sync, or update `name` if company name changed
7. **Set active**, on initial sync, set this dataset as the org's `active_dataset_id`
8. **Mark stale**, call `aiSummaries.markStale(orgId)` so the dashboard shows the refresh nudge
9. **Complete**, update `sync_jobs` row (completed_at, rows_synced), set connection `sync_status: 'idle'`, `last_synced_at: now()`
10. **Track event**, `integration.synced` with `{ provider, trigger, rowsSynced }`

### Error handling

| Error | Behavior |
|-------|----------|
| QB API 429 (rate limit) | BullMQ exponential backoff: 30s, 60s, 120s. Max 3 retries. |
| QB API 5xx | Same backoff. After 3 failures: mark `sync_status: 'error'`, record in `sync_jobs`. |
| Token revoked (401 after refresh attempt) | Mark `sync_status: 'error'`, set `sync_error`, surface reconnect in UI. |
| Partial failure (some pages succeed) | Commit completed pages, record partial count, log error, retry remaining on next scheduled sync. |
| Process crash mid-sync | BullMQ detects stalled job after 30s, re-queues. Connection stays `'syncing'` until worker picks it up. |
| Duplicate manual + scheduled sync | BullMQ concurrency + job deduplication. If a sync is already running for this org, skip the new one. |

### Daily scheduler

On API startup:
1. Query all `integration_connections` where `provider = 'quickbooks'`
2. For each, register a BullMQ repeatable job: `{ repeat: { pattern: '0 3 * * *' }, jobId: 'qb-daily-{orgId}' }`
3. On new connection: add repeatable job
4. On disconnect: remove repeatable job

## API Routes

### New routes

Most routes mount at `/integrations/quickbooks` on the protected router. The callback is an exception, it mounts on the public router (before `authMiddleware`) because Intuit redirects the browser there without auth cookies. CSRF protection comes from the state cookie instead.

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/integrations/quickbooks/connect` | Required | Generate OAuth URL, set state cookie |
| `GET` | `/integrations/quickbooks/callback` | Public (state cookie validates) | OAuth callback, exchange code, store tokens, enqueue sync |
| `GET` | `/integrations/quickbooks/status` | Required | Connection info + sync status |
| `POST` | `/integrations/quickbooks/sync` | Required | Trigger manual refresh |
| `DELETE` | `/integrations/quickbooks` | Required (owner only) | Disconnect, revoke token, delete connection |

### Response shapes

**Status:**
```json
{
  "data": {
    "connected": true,
    "provider": "quickbooks",
    "companyName": "Sunrise Cafe",
    "syncStatus": "idle",
    "lastSyncedAt": "2026-04-15T03:00:00Z",
    "rowsSynced": 1247,
    "syncError": null,
    "connectedAt": "2026-04-10T14:22:00Z"
  }
}
```

**Not connected:**
```json
{
  "data": {
    "connected": false
  }
}
```

**Connect:**
```json
{
  "data": {
    "authUrl": "https://appcenter.intuit.com/connect/oauth2?client_id=...&redirect_uri=...&scope=...&state=..."
  }
}
```

### Analytics events

- `integration.connected`, `{ provider: 'quickbooks', realmId }`
- `integration.disconnected`, `{ provider: 'quickbooks' }`
- `integration.synced`, `{ provider: 'quickbooks', trigger: 'initial' | 'scheduled' | 'manual', rowsSynced }`
- `integration.sync_failed`, `{ provider: 'quickbooks', error, trigger }`

## Frontend

### 1. Upload page, dual onboarding

Modify the existing upload page to show two options side-by-side:

**Left card:** existing CSV upload dropzone (unchanged)

**Right card:** "Connect QuickBooks"
- QuickBooks logo
- "Import your transactions automatically"
- "Connect" button → calls `/integrations/quickbooks/connect`, redirects to Intuit
- If already connected: show sync status badge + "Manage in Settings" link

Mobile: stack vertically (CSV on top, QB below).

### 2. Settings → Integrations page (`/settings/integrations`)

New settings page showing connection status:

**Connected state:**
- QuickBooks logo + company name
- Sync status: "Last synced 3 hours ago" or "Syncing..." with spinner
- Row count: "1,247 transactions imported"
- "Refresh now" button (triggers manual sync)
- "Disconnect" button (owner only, with confirmation)

**Disconnected state:**
- "Connect QuickBooks" CTA with explanation
- "Import transactions, expenses, and revenue data automatically"

**Error state:**
- Error message (e.g., "QuickBooks access was revoked")
- "Reconnect" button

**Sync in progress:**
- Spinner + "Syncing your QuickBooks data..."
- Frontend polls `GET /integrations/quickbooks/status` every 5 seconds while `syncStatus === 'syncing'`
- Stops polling when status changes to `'idle'` or `'error'`

### 3. Dashboard, stale data nudge

When AI summary is stale (data synced since last AI generation):
- Show a banner inside the AI summary card: "Your data has been updated"
- "Refresh insights" button triggers AI regeneration
- Banner disappears after regeneration completes

### 4. Sidebar update

Add "Integrations" to the Settings section:
```
SETTINGS
  Invites
  Datasets
  Preferences
  Integrations    ← new
```

## Error Handling

| Scenario | Response | UI |
|----------|----------|-----|
| QB OAuth denied by user | Redirect to `/dashboard?qb=denied` | Toast: "QuickBooks connection was cancelled" |
| State token mismatch | Redirect to `/dashboard?qb=error` | Toast: "Connection failed, please try again" |
| Token exchange fails | Redirect to `/dashboard?qb=error` | Same toast |
| Sync fails (API error) | `sync_status: 'error'` in DB | Settings shows error + retry option |
| Token revoked externally | `sync_status: 'error'` | Settings shows "Reconnect" |
| Disconnect by non-owner | 403 Forbidden | "Only org owners can disconnect integrations" |
| Already connected (duplicate) | 409 Conflict | "QuickBooks is already connected" |
| Manual sync while syncing | 409 Conflict | "A sync is already in progress" |

## Testing

### Backend (Vitest)

**OAuth flow tests:**
- Connect returns valid auth URL with correct scopes and state
- Callback validates state cookie, rejects mismatched state
- Callback exchanges code and stores encrypted tokens
- Callback enqueues initial-sync job
- Disconnect revokes token and deletes connection
- Disconnect by non-owner returns 403

**Sync pipeline tests (mock QB API):**
- Initial sync fetches all transaction types
- Incremental sync uses `last_synced_at` filter
- Transactions normalize correctly to `data_rows` shape
- Upsert handles new, updated, and unchanged transactions
- Token refresh triggers when access token is near-expiry
- Rate limit (429) triggers retry with backoff
- Token revocation marks connection as error

**Encryption tests:**
- Round-trip: encrypt → decrypt returns original
- Different IVs produce different ciphertexts for same input
- Tampered ciphertext fails decryption (auth tag verification)

### Frontend (Vitest + jsdom)

- Upload page: QB connect card renders, connected state shows sync badge
- Integrations page: connected/disconnected/error states render correctly
- Status polling: starts when syncing, stops when idle
- Dashboard nudge: shows when stale, hides after refresh

## Config Changes

Add to `apps/api/src/config.ts` validation:

```
QUICKBOOKS_CLIENT_ID:     z.string().min(1)
QUICKBOOKS_CLIENT_SECRET: z.string().min(1)
QUICKBOOKS_REDIRECT_URI:  z.string().url()
QUICKBOOKS_ENVIRONMENT:   z.enum(['sandbox', 'production']).default('sandbox')
ENCRYPTION_KEY:           z.string().length(64)  // 32-byte hex
```

All optional with defaults for development (integration disabled when not configured).

## Dependencies

**New npm packages:**
- `bullmq`, job queue (Redis-backed, already have Redis)
- `node-quickbooks` or raw `fetch`, QB API client (raw fetch preferred for control)

**No new infrastructure.** Redis already running, Postgres already running.

## Files to Create or Modify

### New files
- `apps/api/src/services/integrations/quickbooks/oauth.ts`, OAuth flow (connect, callback, refresh, revoke)
- `apps/api/src/services/integrations/quickbooks/sync.ts`, sync pipeline (fetch, normalize, upsert)
- `apps/api/src/services/integrations/quickbooks/api.ts`, QB API client (paginated fetch, token refresh)
- `apps/api/src/services/integrations/quickbooks/normalize.ts`, transaction → data_rows mapping
- `apps/api/src/services/integrations/encryption.ts`, AES-256-GCM encrypt/decrypt
- `apps/api/src/services/integrations/worker.ts`, BullMQ worker setup
- `apps/api/src/routes/integrations.ts`, 5 API routes
- `apps/api/src/routes/integrations.test.ts`, route tests
- `apps/api/src/db/queries/integrationConnections.ts`, CRUD for connections
- `apps/api/src/db/queries/syncJobs.ts`, CRUD for sync history
- `apps/api/drizzle/migrations/0016_add-integration-tables.sql`, migration
- `apps/web/app/settings/integrations/page.tsx`, settings page
- `apps/web/app/settings/integrations/IntegrationsManager.tsx`, client component
- `apps/web/components/integrations/QuickBooksCard.tsx`, upload page card

### Modified files
- `apps/api/src/db/schema.ts`, add `integrationConnections` + `syncJobs` tables
- `apps/api/src/db/queries/index.ts`, export new query modules
- `apps/api/src/routes/protected.ts`, mount integrations router
- `apps/api/src/config.ts`, add QB + encryption env vars
- `apps/api/src/index.ts`, initialize BullMQ worker on startup
- `apps/web/app/upload/UploadDropzone.tsx`, add QB connect card alongside CSV
- `apps/web/app/dashboard/AiSummaryCard.tsx`, add stale data nudge banner
- `apps/web/components/layout/Sidebar.tsx`, add Integrations link
- `packages/shared/src/constants/index.ts`, add integration analytics events
