# QuickBooks Integration — Implementation Plan

**Date:** 2026-04-15
**Spec:** `docs/superpowers/specs/2026-04-15-quickbooks-integration-design.md`
**Estimated Stories:** 9
**Estimated Effort:** ~1 sprint (comparable to Epic 5)

## Why This Order

The dependency chain dictates sequencing: encryption and schema come first because every other story depends on them. OAuth comes before sync because you need tokens before you can call the QB API. The normalizer is isolated from the API client because it's pure logic with zero I/O — testable in isolation. The sync orchestrator ties them together. Frontend stories come last because they consume API endpoints that must already exist.

Stories 1-4 are strictly sequential (each depends on the prior). Stories 5-6 are sequential (normalizer feeds sync). Stories 7-9 have parallelism opportunity — the frontend stories only need the API routes from Story 3 to exist.

## Key Architectural Decisions

### `source_id` column on `data_rows` (not jsonb index)

We add a nullable `source_id` varchar column to `data_rows` instead of indexing `metadata->>'qb_id'`. Reasons:

1. **Query performance at scale.** A B-tree on a varchar column is faster than a functional index on jsonb extraction, especially as `data_rows` grows past 1M rows. The query planner handles it better, and the index is smaller.
2. **Clean upsert SQL.** `ON CONFLICT (org_id, source_id) WHERE source_id IS NOT NULL` is straightforward. The jsonb approach requires a partial expression index that's harder to reason about and maintain.
3. **Cheap migration.** `ALTER TABLE ADD COLUMN ... DEFAULT NULL` is metadata-only in Postgres — no table rewrite, near-instant even on large tables.
4. **Future-proof.** Every integration adapter (Xero, Square, Stripe) uses the same column. No per-provider jsonb extraction logic.

### Split normalizer from sync pipeline

The normalizer (QB transaction → `data_rows` shape) is pure logic with zero I/O — 13 transaction types, multi-line handling, label fallback chains. Isolating it in its own story means:
- Focused tests without mocking HTTP or DB
- Easier code review (the mapping logic is where most bugs will hide)
- The sync orchestrator (Story QB-6) can trust the normalizer and focus on orchestration concerns

## Story Overview

| # | Story | Dependencies | New Files | Modified Files | Tests |
|---|-------|-------------|-----------|----------------|-------|
| QB-1 | Encryption service + config | None | 2 | 2 | ~10 |
| QB-2 | Schema + migrations + queries + `source_id` column | QB-1 | 4 | 3 | ~12 |
| QB-3 | OAuth flow (connect, callback, disconnect) | QB-2 | 3 | 3 | ~14 |
| QB-4 | QB API client (HTTP, pagination, token refresh) | QB-3 | 2 | 0 | ~10 |
| QB-5 | Transaction normalizer | None (pure logic) | 2 | 0 | ~14 |
| QB-6 | Sync pipeline orchestrator | QB-4, QB-5 | 2 | 1 | ~12 |
| QB-7 | BullMQ worker + scheduler | QB-6 | 2 | 2 | ~10 |
| QB-8 | Upload page dual onboarding + QB card | QB-3 (API) | 2 | 2 | ~6 |
| QB-9 | Settings > Integrations + stale nudge + analytics events | QB-3 (API) | 3 | 5 | ~14 |

**Total: ~22 new files, ~13 modified files, ~102 tests**

---

## Story QB-1: Encryption Service + Config Additions

**Status: DONE** (implemented this session)

### Story

As a **developer**,
I want AES-256-GCM encryption utilities and QB-specific config validation,
so that OAuth tokens are encrypted at rest and all QB config is fail-fast validated.

### Acceptance Criteria

1. **Given** `ENCRYPTION_KEY` is set to a 64-char hex string, **When** the API starts, **Then** config validates without error.

2. **Given** `ENCRYPTION_KEY` is missing or malformed, **When** the API starts, **Then** config validation fails with a clear error message, **And** the process exits.

3. **Given** a plaintext string, **When** `encrypt()` is called, **Then** the output is formatted as `iv:authTag:ciphertext` (base64 segments), **And** calling `decrypt()` on the output returns the original string.

4. **Given** two calls to `encrypt()` with the same input, **When** comparing outputs, **Then** they differ (unique IV per call).

5. **Given** a tampered ciphertext (flipped bit in auth tag), **When** `decrypt()` is called, **Then** it throws an error (GCM authentication failure).

6. **Given** QB env vars (`QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`, `QUICKBOOKS_ENVIRONMENT`), **When** they are present, **Then** config exposes them. **When** absent, **Then** config marks QB as not configured (optional group — API starts without them).

### Completed

- [x] `apps/api/src/config.ts` — 5 optional QB env vars + `isQbConfigured()` function
- [x] `apps/api/src/services/integrations/encryption.ts` — AES-256-GCM encrypt/decrypt
- [x] `apps/api/src/services/integrations/encryption.test.ts` — 10 tests, all passing
- [x] `.env.example` — QB config section (commented out)
- [x] `apps/api/src/services/integrations/encryption_explained.md` — interview doc

---

## Story QB-2: Schema, Migrations, Queries, and `source_id` Column

### Story

As a **developer**,
I want `integration_connections` and `sync_jobs` tables with Drizzle schema, migration, and typed query functions, plus a `source_id` column on `data_rows` for idempotent upserts,
so that OAuth tokens, sync history, and integration data rows can be persisted with org-scoped RLS.

### Acceptance Criteria

1. **Given** the migration runs, **When** I inspect the database, **Then** `integration_connections` and `sync_jobs` tables exist with all columns from the spec, **And** `UNIQUE(org_id, provider)` constraint is on `integration_connections`.

2. **Given** an `integration_connections` row, **When** the parent org is deleted, **Then** the connection row cascades to deletion, **And** all related `sync_jobs` cascade too.

3. **Given** RLS is enabled, **When** a request scoped to org A queries connections, **Then** only org A's rows are visible.

4. **Given** query functions, **When** I call `upsertConnection()`, `getConnectionByOrgAndProvider()`, `deleteConnection()`, **Then** they execute correct SQL and return typed results.

5. **Given** query functions, **When** I call `createSyncJob()`, `updateSyncJob()`, `getRecentSyncJobs()`, **Then** they execute correct SQL and return typed results.

6. **Given** the migration runs, **When** I inspect `data_rows`, **Then** a nullable `source_id` varchar(255) column exists, **And** a unique partial index on `(org_id, source_id) WHERE source_id IS NOT NULL` exists.

### Tasks

- [ ] **Task 1: Add `source_id` column to `data_rows` in schema + migration** (AC: 6)
  - Add `sourceId` varchar(255) nullable to `dataRows` in `schema.ts`
  - Migration: `ALTER TABLE data_rows ADD COLUMN source_id VARCHAR(255)`
  - Migration: `CREATE UNIQUE INDEX idx_data_rows_source_id ON data_rows (org_id, source_id) WHERE source_id IS NOT NULL`
  - Existing CSV rows have `source_id = NULL` — the partial index excludes them

- [ ] **Task 2: Add `integration_connections` table to schema** (AC: 1, 2)
  - `id` serial PK
  - `orgId` integer FK → orgs, NOT NULL, ON DELETE CASCADE
  - `provider` varchar(50) NOT NULL
  - `providerTenantId` varchar(255) NOT NULL
  - `encryptedRefreshToken` text NOT NULL
  - `encryptedAccessToken` text NOT NULL
  - `accessTokenExpiresAt` timestamp NOT NULL
  - `scope` varchar(500)
  - `lastSyncedAt` timestamp
  - `syncStatus` varchar(20) NOT NULL default `'idle'`
  - `syncError` text
  - `createdAt` / `updatedAt` timestamps
  - Unique constraint on `(orgId, provider)`

- [ ] **Task 3: Add `sync_jobs` table to schema** (AC: 1, 2)
  - `id` serial PK
  - `orgId` integer FK → orgs, ON DELETE CASCADE
  - `connectionId` integer FK → integrationConnections, ON DELETE CASCADE
  - `trigger` varchar(20) NOT NULL
  - `status` varchar(20) NOT NULL default `'queued'`
  - `startedAt` / `completedAt` timestamps
  - `rowsSynced` integer default 0
  - `error` text
  - `createdAt` timestamp

- [ ] **Task 4: Create migration `0016_add-integration-tables.sql`** (AC: 1, 2, 3, 6)
  - `ALTER TABLE data_rows` for `source_id` + partial unique index
  - `CREATE TABLE integration_connections` + `sync_jobs`
  - RLS policies: tenant isolation by `org_id` + admin bypass (mirrors `0010`, `0011`)
  - Index on `integration_connections(org_id, provider)`
  - Index on `sync_jobs(connection_id)`

- [ ] **Task 5: Create `apps/api/src/db/queries/integrationConnections.ts`** (AC: 4)
  - `getByOrgAndProvider(orgId, provider)` — single row or null
  - `upsert(data)` — insert or update on conflict `(orgId, provider)`
  - `updateSyncStatus(id, status, error?)` — partial update
  - `updateTokens(id, encryptedAccess, encryptedRefresh, expiresAt)` — token refresh
  - `deleteByOrgAndProvider(orgId, provider)` — cascade handled by FK
  - `getAllByProvider(provider)` — for scheduler startup (list all QB connections)

- [ ] **Task 6: Create `apps/api/src/db/queries/syncJobs.ts`** (AC: 5)
  - `create(data)` — insert, return row
  - `update(id, data)` — partial update (status, completedAt, rowsSynced, error)
  - `getRecent(connectionId, limit?)` — last N jobs, newest first

- [ ] **Task 7: Update `apps/api/src/db/queries/index.ts`** (AC: 4, 5)
  - Add barrel exports for both new query modules

- [ ] **Task 8: Write tests** (AC: 1-6)
  - Upsert creates new connection
  - Upsert updates existing connection (same org+provider)
  - Unique constraint rejects duplicate org+provider via direct insert
  - Cascade: deleting org removes connections and sync jobs
  - `getAllByProvider` returns only matching provider
  - `getRecent` returns correct order and limit
  - `source_id` partial index allows multiple NULLs (CSV rows)
  - `source_id` partial index rejects duplicate non-null values within same org
  - `updateSyncStatus` sets status and optional error
  - `updateTokens` replaces encrypted token fields
  - `createSyncJob` returns row with default status 'queued'
  - `updateSyncJob` sets completedAt and rowsSynced

### Notes

- The `sourceTypeEnum` already includes `'quickbooks'` — no enum migration needed.
- RLS pattern from `0010_add-rls-core-tables.sql` and `0011_add-rls-subscriptions.sql`: enable RLS, create `tenant_isolation` policy using `current_setting('app.current_org_id')`, create `admin_bypass` policy using `current_setting('app.is_admin')`.
- The `source_id` partial index (`WHERE source_id IS NOT NULL`) is key: it lets all existing CSV rows coexist with `NULL` source_id while enforcing uniqueness for integration-sourced rows. Postgres doesn't include NULL values in unique index checks by default, but a partial index makes the intent explicit.

---

## Story QB-3: OAuth Flow (Connect, Callback, Disconnect)

### Story

As an **org owner**,
I want to connect my QuickBooks Online account via OAuth,
so that TellSight can access my financial data without me exporting anything.

### Acceptance Criteria

1. **Given** I call `POST /integrations/quickbooks/connect`, **When** QB is configured, **Then** I receive an auth URL with correct client_id, redirect_uri, scope (`com.intuit.quickbooks.accounting`), response_type, and a cryptographic state token, **And** an httpOnly `qb_oauth_state` cookie is set with 10-minute TTL.

2. **Given** Intuit redirects to `GET /integrations/quickbooks/callback` with valid code, realmId, and state, **When** the state matches the cookie, **Then** tokens are exchanged with Intuit, encrypted, and stored in `integration_connections`, **And** `integration.connected` analytics event fires, **And** I am redirected to `/dashboard?qb=connected`.

3. **Given** the callback state param does not match the cookie, **When** the callback fires, **Then** I am redirected to `/dashboard?qb=error` (no tokens stored, no connection created).

4. **Given** I call `DELETE /integrations/quickbooks`, **When** I am an org owner, **Then** the connection is deleted, a best-effort revoke is sent to Intuit, repeatable BullMQ job is removed, **And** `integration.disconnected` event fires. **When** I am a member (not owner), **Then** I get 403.

5. **Given** QB is not configured (env vars missing), **When** any QB endpoint is called, **Then** it returns 501 with `{ error: { code: 'INTEGRATION_NOT_CONFIGURED' } }`.

6. **Given** an org already has a QB connection, **When** `POST /connect` is called, **Then** it returns 409 Conflict.

### Tasks

- [ ] **Task 1: Create `apps/api/src/services/integrations/quickbooks/oauth.ts`** (AC: 1, 2, 3, 4)
  - `generateAuthUrl(orgId)` — builds Intuit OAuth URL, generates random state, returns `{ authUrl, state }`
  - `exchangeCode(code, realmId)` — POST to Intuit token endpoint, returns `{ accessToken, refreshToken, expiresIn, realmId }`
  - `refreshAccessToken(encryptedRefreshToken)` — decrypt, call Intuit, encrypt new tokens, return updated fields
  - `revokeToken(encryptedRefreshToken)` — best-effort POST to Intuit revoke endpoint, catch and log errors
  - All HTTP calls use `fetch` with timeout (10s) and structured error handling
  - Intuit base URLs:
    - Sandbox: `https://sandbox-quickbooks.api.intuit.com`
    - Production: `https://quickbooks.api.intuit.com`
    - OAuth: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`

- [ ] **Task 2: Create `apps/api/src/routes/integrations.ts`** (AC: 1, 2, 3, 4, 5, 6)
  - QB config guard middleware: check `isQbConfigured(env)`, return 501 if false
  - `POST /integrations/quickbooks/connect` (protected)
    - Check no existing connection (409 if exists)
    - Generate auth URL and state
    - Set `qb_oauth_state` httpOnly cookie (10min, sameSite: lax, path: `/`)
    - Return `{ data: { authUrl } }`
  - `GET /integrations/quickbooks/callback` (public — mounted before auth middleware)
    - Validate state against cookie
    - Exchange code for tokens
    - Encrypt tokens, upsert connection
    - Clear state cookie
    - Track `integration.connected` event
    - Redirect to `/dashboard?qb=connected`
    - On any failure: redirect to `/dashboard?qb=error`
  - `GET /integrations/quickbooks/status` (protected)
    - Return connection info or `{ connected: false }`
  - `POST /integrations/quickbooks/sync` (protected)
    - Check connection exists, check not already syncing (409)
    - Enqueue manual-sync job
    - Return `{ data: { message: 'Sync started' } }`
  - `DELETE /integrations/quickbooks` (protected, owner only via roleGuard)
    - Revoke token (best-effort)
    - Delete connection
    - Remove repeatable job
    - Track `integration.disconnected` event

- [ ] **Task 3: Mount routes in server** (AC: 1, 2)
  - Mount callback route on public router (before authMiddleware) — same pattern as `/auth` and `/invites`
  - Mount remaining QB routes on protected router
  - Add BFF proxy rule in `apps/web/proxy.ts` for `/integrations/*` → `:3001`

- [ ] **Task 4: Write OAuth flow tests** (AC: 1-6)
  - Connect returns valid auth URL with all required params
  - Connect sets httpOnly state cookie
  - Connect returns 409 if already connected
  - Connect returns 501 if QB not configured
  - Callback with valid state exchanges tokens and creates connection
  - Callback with mismatched state redirects with error
  - Callback with missing state cookie redirects with error
  - Callback with token exchange failure redirects with error
  - Status returns connection info when connected
  - Status returns `{ connected: false }` when not connected
  - Disconnect deletes connection and fires event
  - Disconnect by non-owner returns 403
  - Disconnect returns 404 if not connected
  - Disconnect sends revoke request (mock Intuit endpoint)

### Notes

- The callback is a browser redirect, not an API call from the frontend. Intuit sends the user's browser to our callback URL. This is why it must be on the public router — the browser won't have auth cookies at that point. CSRF protection comes from the state cookie (set during connect, validated during callback).
- Token refresh lives in `oauth.ts` but gets called by the API client (Story QB-4), not by the routes directly.
- The callback needs the user's `orgId` to store the connection. Options: (a) encode orgId in the state param (signed), (b) read it from the auth cookie if the user happens to still be logged in. Option (a) is more reliable — the state param is already a secure random token, we can make it a signed JWT containing `{ orgId, nonce }`.

---

## Story QB-4: QB API Client (HTTP, Pagination, Token Refresh)

### Story

As a **developer**,
I want an HTTP client for the QuickBooks API that handles pagination, token refresh, and rate limiting,
so that the normalizer and sync pipeline have a reliable data source.

### Acceptance Criteria

1. **Given** a valid access token, **When** `query(type, since?)` is called, **Then** it paginates through all results (1000 per page) and returns an array of raw QB transaction objects.

2. **Given** an access token that expires within 5 minutes, **When** any API call is made, **Then** the client refreshes the token first, stores the new encrypted tokens, and proceeds with the fresh token.

3. **Given** a QB API 429 response, **When** the client encounters it, **Then** it throws a `RetryableError` that BullMQ can catch and backoff on.

4. **Given** a QB API 5xx response, **When** the client encounters it, **Then** it throws a `RetryableError`.

5. **Given** a refresh token that has been revoked, **When** the client attempts to refresh, **Then** it throws a `TokenRevokedError` and marks the connection status as `'error'`.

6. **Given** the `QUICKBOOKS_ENVIRONMENT` config, **When** the client initializes, **Then** it targets the sandbox or production API base URL accordingly.

7. **Given** a QB API call, **When** it does not respond within 30 seconds, **Then** the client aborts and throws a timeout error.

### Tasks

- [ ] **Task 1: Create `apps/api/src/services/integrations/quickbooks/errors.ts`**
  - `RetryableError extends Error` — BullMQ checks `error.retryable` or we catch by type
  - `TokenRevokedError extends Error` — triggers reconnect flow
  - `QbApiError extends Error` — wraps QB API error responses with status code

- [ ] **Task 2: Create `apps/api/src/services/integrations/quickbooks/api.ts`** (AC: 1-7)
  - `createQbClient(connectionId)` — factory that loads connection from DB, returns client object
  - `client.query(entityType, since?)` — paginated query using QB's SQL-like API
    - URL: `GET /v3/company/{realmId}/query?query=SELECT * FROM {type} STARTPOSITION {n} MAXRESULTS 1000`
    - Handles pagination: repeat until result count < maxResults
    - For incremental: append `WHERE MetaData.LastUpdatedTime > '{since}'`
  - `client.getCompanyInfo()` — `GET /v3/company/{realmId}/companyinfo/{realmId}`
  - Internal `_fetch(url, opts)`:
    - Checks `accessTokenExpiresAt` — if < 5 min remaining, calls `refreshAccessToken()`
    - Sets `Authorization: Bearer {accessToken}`, `Accept: application/json`
    - `AbortSignal.timeout(30_000)` for request timeout
    - On 429/5xx: throw `RetryableError`
    - On 401 after refresh attempt: throw `TokenRevokedError`, update connection to error
  - Base URL from `config.QUICKBOOKS_ENVIRONMENT`:
    - sandbox: `https://sandbox-quickbooks.api.intuit.com`
    - production: `https://quickbooks.api.intuit.com`

- [ ] **Task 3: Write API client tests (mock HTTP)** (AC: 1-7)
  - Single-page query returns all transactions
  - Multi-page query paginates and concatenates results
  - Incremental query appends WHERE clause with since date
  - Near-expiry token triggers refresh before API call
  - Valid token skips refresh
  - 429 response throws RetryableError
  - 5xx response throws RetryableError
  - 401 after refresh throws TokenRevokedError
  - 401 after refresh updates connection sync_status to 'error'
  - Request times out after 30s (AbortSignal)

### Notes

- We use raw `fetch` (Node 22 built-in) instead of the `node-quickbooks` npm package. The QB API is REST + SQL-like queries — `fetch` gives us full control over timeout, retry semantics, and token refresh without fighting a wrapper library's opinions.
- The QB query API uses a SQL-like syntax: `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '2026-04-01T00:00:00Z' STARTPOSITION 1 MAXRESULTS 1000`. It's string concatenation, but the "variables" are ISO dates and integers — no user input, no injection risk.
- Token refresh is a critical section. If two concurrent requests both detect an expired token, both will try to refresh. The client should use a simple in-memory mutex (or just serialize through a `refreshing` promise) to avoid double-refresh.

---

## Story QB-5: Transaction Normalizer

### Story

As a **developer**,
I want a pure-function normalizer that maps QuickBooks transactions to `data_rows` shape,
so that the sync pipeline can insert QB data alongside CSV data in a consistent format.

### Acceptance Criteria

1. **Given** a Purchase transaction, **When** `normalize(tx, 'Purchase')` is called, **Then** it returns rows with `parentCategory: 'Expenses'`, correct `date`, `amount`, `category`, `label`, and `sourceType: 'quickbooks'`.

2. **Given** an Invoice transaction, **When** `normalize(tx, 'Invoice')` is called, **Then** it returns rows with `parentCategory: 'Income'`.

3. **Given** a transaction with multiple line items, **When** normalized, **Then** it produces one `data_rows` entry per line item, each with `sourceId: '{txId}-{lineNum}'`.

4. **Given** a transaction with an `EntityRef` (vendor/customer name), **When** normalized, **Then** `label` is the entity name. **Given** no `EntityRef`, **When** normalized, **Then** `label` falls back to `PrivateNote`, then `DocNumber`, then `'Unknown'`.

5. **Given** a line item with an `AccountRef`, **When** normalized, **Then** `category` is the account name. **Given** no `AccountRef`, **When** normalized, **Then** `category` is `'Uncategorized'`.

6. **Given** a JournalEntry with mixed account types, **When** normalized, **Then** credit lines with revenue accounts get `parentCategory: 'Income'`, debit lines with expense accounts get `parentCategory: 'Expenses'`.

7. **Given** any normalized row, **When** inspected, **Then** `metadata` contains `qb_id`, `txnType`, `docNumber`, and `memo`.

### Tasks

- [ ] **Task 1: Create `apps/api/src/services/integrations/quickbooks/normalize.ts`** (AC: 1-7)
  - `normalizeTransaction(tx: QbTransaction, txType: string): NormalizedRow[]`
  - Type-to-parentCategory map:
    - Expenses: Purchase, Bill, BillPayment, VendorCredit
    - Income: Invoice, Payment, SalesReceipt, Deposit, CreditMemo, RefundReceipt
    - Derived: JournalEntry (per-line based on account classification)
    - Other: Transfer, Estimate
  - Per line item:
    - `date` ← `tx.TxnDate` (ISO string)
    - `amount` ← `Math.abs(line.Amount)` (always positive, parentCategory encodes direction)
    - `category` ← `line.AccountRef?.name ?? 'Uncategorized'`
    - `label` ← `tx.EntityRef?.name ?? tx.PrivateNote ?? tx.DocNumber ?? 'Unknown'`
    - `sourceId` ← `${tx.Id}-${line.Id ?? lineIndex}`
    - `sourceType` ← `'quickbooks'`
    - `metadata` ← `{ qb_id: tx.Id, txnType, docNumber: tx.DocNumber, memo: tx.PrivateNote }`
  - `NormalizedRow` type: matches `data_rows` insert shape minus `id`, `orgId`, `datasetId`

- [ ] **Task 2: Define QB transaction types** 
  - `QbTransaction` — minimal type covering the fields we extract (Id, TxnDate, Line[], EntityRef, PrivateNote, DocNumber, MetaData)
  - `QbLine` — line item shape (Id, Amount, AccountRef, DetailType)
  - These are partial types — we don't model the full QB API response, just what we consume. Keeps the type surface small and honest.

- [ ] **Task 3: Write normalizer tests** (AC: 1-7)
  - Purchase → Expenses parentCategory
  - Invoice → Income parentCategory
  - SalesReceipt → Income parentCategory
  - Bill → Expenses parentCategory
  - JournalEntry credit line with revenue account → Income
  - JournalEntry debit line with expense account → Expenses
  - Transfer → Other parentCategory
  - Multi-line transaction → one row per line item
  - Single-line transaction → one row
  - sourceId format: `{txId}-{lineId}`
  - sourceId fallback: `{txId}-{lineIndex}` when no line Id
  - Label: entity name preferred
  - Label: falls back to PrivateNote, then DocNumber, then 'Unknown'
  - Category from AccountRef.name, fallback 'Uncategorized'

### Notes

- This story has zero I/O dependencies — all tests use fixture objects. It can technically be built in parallel with QB-3 and QB-4. It's sequenced after QB-2 only because it references the `NormalizedRow` type which aligns with the `data_rows` schema.
- We model QB transaction types as lightweight partial interfaces, not the full Intuit API spec. The full spec has hundreds of fields per transaction type. We extract maybe 8 fields. Modeling the full thing would be noise.
- `Math.abs(line.Amount)` is intentional — QB sometimes uses negative amounts for credits/refunds. We normalize to positive amounts and use `parentCategory` to encode the direction. The curation pipeline already expects this convention from CSV data.

---

## Story QB-6: Sync Pipeline Orchestrator

### Story

As a **developer**,
I want a sync pipeline that ties together the API client (QB-4) and normalizer (QB-5) to fetch, transform, and upsert QB data,
so that the BullMQ worker (QB-7) can call a single `runSync()` function.

### Acceptance Criteria

1. **Given** an initial sync, **When** `runSync(connectionId, 'initial')` is called, **Then** it fetches all 13 transaction types, normalizes them, creates a dataset named `"QuickBooks — {companyName}"`, upserts all rows, sets the dataset as `activeDatasetId`, marks AI summaries stale, and returns `{ rowsSynced }`.

2. **Given** an incremental sync, **When** `runSync(connectionId, 'scheduled')` is called, **Then** it only fetches transactions updated since `lastSyncedAt`, **And** upserts only changed/new rows.

3. **Given** normalized rows, **When** `upsertRows()` is called, **Then** new rows are inserted, changed rows (different amount/date/category) are updated, and identical rows are skipped, **And** idempotency is keyed on `source_id` + `org_id`.

4. **Given** a sync completes, **When** the pipeline finishes, **Then** `sync_jobs` is updated with `status: 'completed'`, `rows_synced`, and `completed_at`, **And** `integration_connections.sync_status` is set to `'idle'` with `last_synced_at: now()`.

5. **Given** a sync fails at any step, **When** the error is caught, **Then** `sync_jobs` is updated with `status: 'failed'` and the error message, **And** `integration_connections.sync_status` is set to `'error'` with `sync_error`.

6. **Given** a batch of 2000+ rows, **When** upserting, **Then** rows are batched in groups of 500 to avoid oversized SQL statements.

### Tasks

- [ ] **Task 1: Create `apps/api/src/services/integrations/quickbooks/sync.ts`** (AC: 1-6)
  - `runSync(connectionId: number, trigger: 'initial' | 'scheduled' | 'manual'): Promise<{ rowsSynced: number }>`
    1. Create `sync_jobs` row (status: running, trigger)
    2. Load connection from DB
    3. Create QB client (`createQbClient(connectionId)`)
    4. Fetch company info (for dataset name)
    5. Determine transaction types to fetch (all 13)
    6. For each type: `client.query(type, since?)` → `normalizeTransaction(tx, type)` → accumulate rows
    7. Find or create dataset: `"QuickBooks — {companyName}"` with `sourceType: 'quickbooks'`
    8. `upsertRows(orgId, datasetId, normalizedRows)` — batch of 500
    9. On initial: set `activeDatasetId` on the org
    10. Mark AI summaries stale: `aiSummariesQueries.markStale(orgId)`
    11. Update sync job: completed, rowsSynced
    12. Update connection: idle, lastSyncedAt
    13. Track `integration.synced` analytics event
  - On error at any step:
    - Update sync job: failed, error message
    - Update connection: error, syncError
    - Track `integration.sync_failed` event
    - Re-throw (BullMQ handles retry decision)

- [ ] **Task 2: Implement `upsertRows()`** (AC: 3, 6)
  - Uses `ON CONFLICT (org_id, source_id) WHERE source_id IS NOT NULL`
  - On conflict: update `amount`, `date`, `category`, `parent_category`, `label`, `metadata`
  - Batch: chunk array into groups of 500, execute each as a single INSERT..ON CONFLICT
  - Return total rows affected (inserted + updated)

- [ ] **Task 3: Add `markStale` to AI summaries queries** (AC: 1)
  - `aiSummariesQueries.markStale(orgId)` — `UPDATE ai_summaries SET stale_at = now() WHERE org_id = $1 AND stale_at IS NULL`
  - Add to existing `apps/api/src/db/queries/aiSummaries.ts`

- [ ] **Task 4: Write sync pipeline tests** (AC: 1-6)
  - Initial sync creates dataset with correct name
  - Initial sync sets activeDatasetId on org
  - Initial sync fetches all 13 transaction types
  - Incremental sync passes lastSyncedAt to query
  - Upsert inserts new rows
  - Upsert updates changed rows (different amount)
  - Upsert skips identical rows
  - Upsert batches at 500 rows
  - Sync marks AI summaries stale
  - Sync updates sync_jobs on completion
  - Sync updates connection status to idle on completion
  - Sync updates sync_jobs and connection on failure
  - Sync tracks analytics events on success and failure

### Notes

- The 13 transaction types: Purchase, Invoice, Payment, SalesReceipt, Bill, BillPayment, JournalEntry, Deposit, Transfer, Estimate, CreditMemo, RefundReceipt, VendorCredit. In practice, most small businesses produce mostly Purchase + Invoice + Payment + SalesReceipt. But fetching all types avoids silent data gaps.
- `markStale` is additive — it sets `stale_at` only where it's currently NULL. This prevents resetting the stale timestamp on every sync when the user hasn't regenerated the summary yet.

---

## Story QB-7: BullMQ Worker + Scheduler

### Story

As a **developer**,
I want a BullMQ worker that processes sync jobs with retry logic, and a scheduler that registers daily syncs for all connected orgs,
so that QB data stays fresh automatically and manual syncs are queued reliably.

### Acceptance Criteria

1. **Given** the API starts, **When** QB is configured, **Then** a BullMQ worker connects to Redis and begins processing the `quickbooks-sync` queue with concurrency 2.

2. **Given** a sync job is enqueued, **When** the worker picks it up, **Then** it calls `runSync()` from Story QB-6 with the correct connectionId and trigger.

3. **Given** a sync fails with a retryable error (429, 5xx), **When** BullMQ retries, **Then** it uses exponential backoff (30s, 60s, 120s) up to 3 attempts.

4. **Given** the API starts, **When** QB connections exist, **Then** a repeatable job is registered for each: `{ repeat: { pattern: '0 3 * * *' }, jobId: 'qb-daily-{orgId}' }`.

5. **Given** a new QB connection is created (Story QB-3), **When** the initial sync is enqueued, **Then** a daily repeatable job is also registered for that org.

6. **Given** a QB connection is deleted (Story QB-3), **When** disconnect completes, **Then** the repeatable job for that org is removed.

7. **Given** the API shuts down gracefully, **When** SIGTERM is received, **Then** the BullMQ worker closes cleanly (waits for running jobs up to 30s).

### Tasks

- [ ] **Task 1: Install BullMQ**
  - `pnpm add bullmq --filter api`
  - BullMQ uses the existing Redis connection — no new infrastructure

- [ ] **Task 2: Create `apps/api/src/services/integrations/worker.ts`** (AC: 1, 2, 3, 7)
  - `initSyncWorker()` — creates BullMQ `Worker` on `quickbooks-sync` queue
    - Concurrency: 2
    - Processor: calls `runSync(job.data.connectionId, job.data.trigger)`
    - Connection: reuses `config.REDIS_URL`
  - `getSyncQueue()` — lazy singleton `Queue` instance for enqueuing jobs
  - `enqueueSyncJob(connectionId, trigger)` — adds job with retry config: `{ attempts: 3, backoff: { type: 'exponential', delay: 30000 } }`
  - `shutdownWorker()` — `worker.close()` for graceful shutdown

- [ ] **Task 3: Create `apps/api/src/services/integrations/scheduler.ts`** (AC: 4, 5, 6)
  - `registerDailySync(orgId, connectionId)` — adds repeatable job `{ repeat: { pattern: '0 3 * * *' }, jobId: 'qb-daily-{orgId}' }`
  - `removeDailySync(orgId)` — removes repeatable job by jobId
  - `initScheduler()` — on startup, queries all QB connections, registers repeatable jobs for each

- [ ] **Task 4: Update `apps/api/src/index.ts`** (AC: 1, 4, 7)
  - In startup sequence (after Redis connects): call `initSyncWorker()` and `initScheduler()` if `isQbConfigured(env)`
  - In shutdown handler: call `shutdownWorker()` alongside existing cleanup

- [ ] **Task 5: Wire enqueue calls into Story QB-3 routes** (AC: 5, 6)
  - After OAuth callback creates connection: call `enqueueSyncJob(connectionId, 'initial')` + `registerDailySync(orgId, connectionId)`
  - After disconnect deletes connection: call `removeDailySync(orgId)`
  - After manual sync route: call `enqueueSyncJob(connectionId, 'manual')`

- [ ] **Task 6: Write worker + scheduler tests** (AC: 1-7)
  - Worker processes enqueued job and calls runSync
  - Worker retries on retryable error with exponential backoff
  - Worker marks job failed after 3 attempts
  - Scheduler registers repeatable job for existing connection
  - Scheduler removes repeatable job on disconnect
  - Duplicate manual sync while syncing returns 409 (from route, not worker)
  - Graceful shutdown waits for running job
  - Worker does nothing when QB not configured
  - Stalled job gets re-queued (BullMQ built-in, verify config)
  - Job deduplication: same org can't have two active syncs

### Notes

- BullMQ worker runs in the API process, not a separate service. For a portfolio project with one API instance, this is fine. The code is structured to extract into a standalone worker process later — just a new entry point importing the same modules.
- The `initScheduler()` startup query hits `integration_connections` once — not a performance concern even at scale.
- Graceful shutdown is already handled in `index.ts` with a 30s timeout. Adding `shutdownWorker()` to the existing cleanup chain keeps it consistent.

---

## Story QB-8: Upload Page — Dual Onboarding Card

### Story

As a **user visiting the upload page**,
I want to see a "Connect QuickBooks" option alongside CSV upload,
so that I can onboard with my existing accounting data in two clicks.

### Acceptance Criteria

1. **Given** I visit `/upload`, **When** QB is configured (feature flag from API), **Then** I see two cards side-by-side: CSV upload (left) and QuickBooks connect (right). **When** QB is not configured, **Then** only the CSV upload shows (no broken card).

2. **Given** the QB card is visible, **When** I click "Connect QuickBooks", **Then** the frontend calls `POST /api/integrations/quickbooks/connect` and redirects to the returned `authUrl`.

3. **Given** my org already has a QB connection, **When** I visit `/upload`, **Then** the QB card shows sync status (last synced time, row count) and a "Manage in Settings" link instead of the connect button.

4. **Given** I'm on mobile, **When** I visit `/upload`, **Then** the cards stack vertically (CSV on top, QB below).

5. **Given** I return from Intuit OAuth with `?qb=connected`, **When** the dashboard loads, **Then** a toast shows "QuickBooks connected — syncing your data".

### Tasks

- [ ] **Task 1: Create `apps/web/components/integrations/QuickBooksCard.tsx`** (AC: 1, 2, 3, 4)
  - Fetches QB status from `/api/integrations/quickbooks/status` on mount
  - Disconnected: QB logo + "Import your transactions automatically" + "Connect" button
  - Connected: sync status badge + last synced relative time + row count + "Manage in Settings" link
  - Loading: skeleton state while status fetches
  - Error handling: if status endpoint returns 501 (not configured), card doesn't render
  - Connect button: POST to `/api/integrations/quickbooks/connect`, then `window.location.href = authUrl`

- [ ] **Task 2: Modify `apps/web/app/upload/UploadDropzone.tsx`** (AC: 1, 4)
  - Wrap existing dropzone in a flex container
  - Add `<QuickBooksCard />` as sibling
  - Responsive: `flex-row` on desktop, `flex-col` on mobile (Tailwind `md:flex-row`)
  - Gate on QB availability: only render card if status endpoint doesn't 501

- [ ] **Task 3: Handle OAuth return toasts** (AC: 5)
  - In dashboard page or layout: read `qb` query param
  - `qb=connected` → success toast
  - `qb=denied` → info toast ("QuickBooks connection was cancelled")
  - `qb=error` → error toast ("Connection failed — please try again")
  - Clear query param after showing toast (replace URL)

- [ ] **Task 4: Write frontend tests** (AC: 1-4)
  - QB card renders when status returns disconnected
  - QB card shows sync info when status returns connected
  - QB card hidden when status returns 501
  - Connect button calls correct endpoint
  - Cards stack vertically at mobile breakpoint
  - Toast displays for each qb query param value

---

## Story QB-9: Settings > Integrations + Stale Nudge + Analytics Events

### Story

As an **org member**,
I want a Settings > Integrations page showing my QuickBooks connection status, a stale-data nudge on the dashboard, and complete analytics tracking,
so that I can monitor sync health, trigger manual refreshes, disconnect, and refresh AI insights when data updates.

### Acceptance Criteria

1. **Given** I navigate to `/settings/integrations`, **When** QB is connected, **Then** I see the company name, sync status, last synced time, row count, "Refresh now" button, and "Disconnect" button (owner only).

2. **Given** sync is in progress, **When** I view the page, **Then** I see a spinner with "Syncing your QuickBooks data...", **And** the page polls status every 5 seconds, **And** polling stops when status changes to idle or error.

3. **Given** a sync error occurred, **When** I view the page, **Then** I see the error message and a "Reconnect" button.

4. **Given** I am not an org owner, **When** I view the page, **Then** the "Disconnect" button is hidden.

5. **Given** I click "Disconnect", **When** the confirmation dialog appears and I confirm, **Then** the connection is deleted and the page updates to show the disconnected state.

6. **Given** I click "Refresh now", **When** the sync is not already running, **Then** a manual sync is triggered and the UI transitions to the syncing state.

7. **Given** a QB sync completes and `aiSummaries.staleAt` is set, **When** I view the dashboard, **Then** a banner appears in the AI summary card: "Your data has been updated — refresh insights?" with a "Refresh insights" button.

8. **Given** I click "Refresh insights", **When** the AI regeneration completes, **Then** the banner disappears and the new summary displays.

9. **Given** any QB integration action occurs, **When** it completes, **Then** the correct analytics event fires with the metadata defined in the spec.

### Tasks

- [ ] **Task 1: Update `packages/shared/src/constants/index.ts`** (AC: 9)
  - Add analytics event constants:
    - `INTEGRATION_CONNECTED: 'integration.connected'`
    - `INTEGRATION_DISCONNECTED: 'integration.disconnected'`
    - `INTEGRATION_SYNCED: 'integration.synced'`
    - `INTEGRATION_SYNC_FAILED: 'integration.sync_failed'`

- [ ] **Task 2: Create `apps/web/app/settings/integrations/page.tsx`** (AC: 1)
  - Server component wrapper, fetches initial QB status via BFF
  - Pass status data to client component

- [ ] **Task 3: Create `apps/web/app/settings/integrations/IntegrationsManager.tsx`** (AC: 1-6)
  - Client component with three states: connected, disconnected, error
  - **Connected state:**
    - QB logo + company name
    - Sync status badge (idle/syncing/error)
    - "Last synced {relative time}" or "Syncing..." with spinner
    - "{n} transactions imported"
    - "Refresh now" button → `POST /api/integrations/quickbooks/sync`
    - "Disconnect" button (owner only) → confirmation dialog → `DELETE /api/integrations/quickbooks`
  - **Disconnected state:**
    - "Connect QuickBooks" CTA with explanation text
    - Connect button → same flow as QuickBooksCard
  - **Error state:**
    - Error message display
    - "Reconnect" button → same connect flow (creates new connection)
  - **Polling:** `useEffect` with 5s interval when `syncStatus === 'syncing'`, cleanup on unmount or status change

- [ ] **Task 4: Update `apps/web/components/layout/Sidebar.tsx`** (AC: 1)
  - Add "Integrations" nav item in Settings section (after Preferences)
  - Icon: `Plug` from lucide-react
  - Route: `/settings/integrations`

- [ ] **Task 5: Update `apps/web/app/dashboard/AiSummaryCard.tsx`** (AC: 7, 8)
  - Check if `cachedSummary.staleAt` exists and is in the past
  - If stale: render banner with "Your data has been updated" message + "Refresh insights" button
  - "Refresh insights" triggers the existing SSE stream regeneration flow
  - On stream complete: banner hides (staleAt is cleared server-side when new summary generates)
  - If not stale: no banner (existing behavior)

- [ ] **Task 6: Write tests** (AC: 1-9)
  - Connected state renders all elements
  - Disconnected state renders connect CTA
  - Error state renders error message and reconnect button
  - Disconnect button hidden for non-owners
  - Disconnect flow: button → confirmation → delete call → state update
  - Refresh button triggers sync and transitions to syncing state
  - Polling starts when syncing, stops when idle
  - Polling stops on unmount (no memory leak)
  - Stale banner shows when staleAt is in the past
  - Stale banner hidden when staleAt is null
  - Refresh insights button triggers AI regeneration
  - Banner disappears after regeneration completes
  - Analytics events: verify each constant matches spec
  - Sidebar shows Integrations link

---

## Build Sequence

```
QB-1 (Encryption + Config)  ✅ DONE
  └─► QB-2 (Schema + Queries + source_id)
       └─► QB-3 (OAuth Flow)
            ├─► QB-4 (API Client)
            │    └─► QB-6 (Sync Pipeline)
            │         └─► QB-7 (BullMQ Worker + Scheduler)
            ├─► QB-5 (Normalizer — pure logic, parallel-safe)
            ├─► QB-8 (Upload Page QB Card)
            └─► QB-9 (Settings + Stale Nudge + Analytics)
```

QB-5 (normalizer) has no I/O dependencies and can be built in parallel with QB-4. QB-8 and QB-9 can start once QB-3's API routes exist.

## Dependencies

| Dependency | Type | Notes |
|-----------|------|-------|
| `bullmq` | npm | New package. Redis-backed job queue. |
| Intuit Developer App | External | Need client ID + secret from developer.intuit.com. Sandbox available for free. |
| `ENCRYPTION_KEY` | Env var | Generate with `openssl rand -hex 32`. Must be in `.env` before QB features work. |
| QB sandbox company | External | Intuit provides test companies with sample data. Need one for integration testing. |

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Intuit OAuth flow has quirks not in docs | Medium | Medium | Use sandbox extensively. Budget extra time for QB-3. |
| Multi-line transaction normalization is complex | High | Low | Isolated in QB-5 with focused tests. Start with single-line, extend. |
| BullMQ adds operational complexity | Low | Medium | Worker runs in-process for portfolio. Clear logging. Stalled job detection built-in. Extractable to standalone process. |
| Token refresh race condition (two syncs try to refresh) | Low | High | In-memory mutex in API client. BullMQ concurrency of 2 helps but doesn't eliminate. |
| QB rate limits tighter than expected | Low | Medium | Conservative pagination (1000/page). Exponential backoff. Daily sync avoids burst. |
| `source_id` partial index performance at scale | Very Low | Low | Partial index is small (only non-null rows). B-tree on varchar is Postgres's bread and butter. |

## What This Doesn't Cover

- **Xero / Square / Stripe adapters** — same integration framework, different provider implementations. The `provider` column and `services/integrations/{provider}/` structure is ready.
- **Webhook-based sync** — Intuit supports webhooks for real-time updates. Daily poll is simpler and sufficient for MVP. Webhook support is a natural follow-up.
- **Multi-company support** — one QB connection per org. If an org has multiple QB companies, they'd need multiple orgs. Not a current requirement.
- **Historical sync management** — no UI for viewing/retrying past sync jobs. The `sync_jobs` table stores history, but it's only surfaced through the current status endpoint. An admin view could expose it later.
- **Key rotation** — encryption key is static. In production, add key versioning (prefix ciphertext with key ID) to support rotation without a flag-day migration.
