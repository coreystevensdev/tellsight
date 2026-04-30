# QuickBooks Integration: Completion, Testing, Deployment & Monitoring

**Date:** 2026-04-17
**Status:** Approved
**Builds on:** `2026-04-15-quickbooks-integration-design.md` (original QB spec)
**Scope:** Frontend stories QB-8/QB-9, E2E testing, staging/deployment, error monitoring

## Context

QB-1 through QB-7 are landed. The backend is production-ready: OAuth, API client with pagination and token refresh mutex, transaction normalizer (13 types), sync orchestrator, BullMQ worker/scheduler, DB schema with RLS. The email digest feature and integrations settings page also shipped.

This spec covers everything remaining to make QuickBooks production-ready.

---

## 1. Frontend: Upload Page Dual Onboarding (QB-8)

### Design Decision
Side-by-side cards with equal weight. CSV and QuickBooks are presented as peer onboarding paths.

### Layout
Two cards in a `grid grid-cols-1 md:grid-cols-2` layout on the upload page:

**Left card, CSV upload:**
- Existing dropzone behavior (drag & drop, click to browse)
- File icon, "Upload a CSV" heading
- Subtitle: "Square, Wave, bank export"
- Dashed border (existing style)

**Right card, QuickBooks connect:**
- Link icon, "Connect QuickBooks" heading
- Subtitle: "Auto-sync your accounting data"
- Green "Connect" button (Intuit brand color `#2ca01c`)
- Solid border (distinguishes from the dropzone)
- "or" text centered between the two cards

**Connected state:**
When QB is already connected, the right card changes to:
- "Connected, manage in Integrations" with a link to `/settings/integrations`
- Connect button replaced with link, preventing duplicate connections

**Mobile:**
Cards stack vertically. CSV on top, QB below.

### Files to Create/Modify
- `apps/web/app/upload/QuickBooksCard.tsx`, new component
- `apps/web/app/upload/page.tsx`, add QB card alongside CSV dropzone

---

## 2. Frontend: Dashboard Stale Data Nudge (QB-9)

### Design Decision
Inline amber footer stripe inside the AI summary card. No separate banner, no dimming.

### Behavior
When `ai_summaries.stale_at` is set for the active dataset:
- An amber footer appears at the bottom of the `AiSummaryCard` component
- Copy: "New QuickBooks data available" (or "New data uploaded" if triggered by CSV upload)
- "Refresh" button on the right side of the footer
- Clicking "Refresh" triggers a new AI summary generation (existing SSE endpoint)
- Footer disappears once the new summary streams in
- Old summary remains fully visible and readable while the nudge is showing

### Trigger-Specific Copy
The nudge copy reflects what caused the staleness:
- QB sync: "New QuickBooks data available"
- CSV upload: "New data uploaded"

Add a `stale_reason` column (`text`, nullable) to `ai_summaries` with values: `sync`, `upload`, `manual`. Set it alongside `stale_at` in the existing `markStale()` function. Migration: `0018_add-stale-reason.sql`.

### Error Handling
If the refresh request fails (500, timeout), show an error toast. The nudge stays visible so the user can retry. The old summary remains readable.

### Files to Create/Modify
- `apps/web/app/dashboard/AiSummaryCard.tsx`, add stale footer
- `apps/api/src/db/queries/aiSummaries.ts`, expose `stale_at` and `stale_reason` in the response, update `markStale()` to accept a reason parameter
- `apps/api/src/db/schema.ts`, add `stale_reason` column to `ai_summaries`
- `apps/api/drizzle/migrations/0018_add-stale-reason.sql`, new migration
- `apps/api/src/services/integrations/quickbooks/sync.ts`, pass `'sync'` to `markStale()`
- `apps/api/src/routes/datasets.ts`, pass `'upload'` to `markStale()` on CSV upload

---

## 3. Integration Testing

### Strategy
Three tiers: unit/integration tests with mocked QB API (CI), Playwright E2E browser tests (CI), manual sandbox checklist (pre-launch).

### Tier 1: Mocked Integration Tests (~30-40 tests, Vitest)

Mock at the `createQbClient()` boundary. The factory returns a fake client serving canned QB API responses.

**Sync orchestrator tests:**
- Initial sync creates dataset and activates it
- Incremental sync uses `lastSyncedAt` filter
- Partial failure writes checkpoint, next sync resumes
- All 13 transaction types normalize correctly (existing: 19 tests)
- Multi-line expansion (JournalEntry, Invoice with line items)
- `source_id` idempotency, re-sync doesn't duplicate rows
- Stale marking fires after successful sync
- Analytics events emitted for sync lifecycle

**Worker tests:**
- Job processing calls `runSync` with correct args
- `TokenRevokedError` is terminal (no retry)
- Retryable errors trigger exponential backoff
- Concurrency limit respected

**Route handler tests:**
- `POST /connect` returns auth URL and sets state cookie
- `GET /callback` validates state cookie, exchanges code, creates connection
- `GET /callback` with `error=access_denied` returns error response
- `GET /status` returns connection status for authenticated user
- `POST /sync` enqueues a manual sync job
- `DELETE /` owner-only, revokes token, removes scheduler job
- `DELETE /` by member returns 403

### Tier 2: Playwright E2E Tests (25 tests)

Run against Next.js dev server with API responses mocked via `page.route()`. No real QB sandbox, no Intuit credentials in CI.

**File:** `apps/web/e2e/quickbooks.spec.ts`

**Happy path (4 tests):**
1. Connect from upload page, click QB card, verify redirect, simulate callback, verify connected status
2. Connect from integrations page, same flow from Settings
3. Stale nudge + refresh, amber footer visible, click Refresh, new summary streams, footer disappears
4. Disconnect preserves data, disconnect, verify charts still render

**Error states (2 tests):**
5. OAuth denial, callback with `error=access_denied`, verify error message, no connection
6. Sync failure, mock error status, verify red error text, retry button enabled

**Access control (1 test):**
7. Non-owner can't disconnect, member role, Disconnect button hidden

**Polling behavior (1 test):**
8. Sync polling lifecycle, click Sync, spinner, status transitions, final timestamp

**Token edge cases (2 tests):**
9. Silent token refresh, 401 then success, no flash of disconnected state
10. Token revoked permanently, Reconnect CTA replaces Sync button

**Data edge cases (2 tests):**
11. First sync creates and activates dataset, empty dashboard, connect, sync, dataset appears in switcher
12. QB + CSV coexistence, both datasets in switcher, switching changes charts

**UI resilience (2 tests):**
13. Double-click protection, only one OAuth redirect fires
14. Navigate-away polling, leave and return, polling resumes correctly

**Network resilience (2 tests):**
15. Offline during poll, retry indicator, recovery on reconnect
16. Slow callback, loading state visible during delay

**Multi-org (2 tests):**
17. Per-org connections, org A connected, org B disconnected
18. Owner vs member visibility, member sees status but no Disconnect

**Dashboard integration (2 tests):**
19. Trigger-specific nudge copy, QB sync vs CSV upload shows different text
20. Charts vs summary refresh, charts reflect data_rows (already current), only AI summary refreshes

**Upload page (2 tests):**
21. QB card disabled when connected, shows "manage in Integrations" link
22. CSV upload while QB connected, second dataset appears, QB unaffected

**Stale nudge edge cases (2 tests):**
23. No duplicate nudges, rapid syncs produce one footer
24. Refresh failure, error toast, nudge stays, old summary readable

**Lifecycle (1 test):**
25. Full round-trip, connect, sync, nudge, refresh, disconnect, reconnect, verify no duplicates

### Tier 3: Manual Sandbox Checklist

**File:** `docs/quickbooks-sandbox-checklist.md`

Steps for pre-launch manual validation against a real Intuit sandbox:
1. Create Intuit developer account and sandbox app
2. Configure redirect URI to staging domain
3. Connect sandbox company ("Sandbox Company_US_1")
4. Verify initial sync populates dashboard with correct transaction count
5. Trigger manual sync, verify incremental (no duplicates)
6. Verify stale nudge appears on dashboard
7. Refresh insights, verify new AI summary generates
8. Disconnect, verify data persists
9. Reconnect, verify no duplicate rows
10. Check Sentry for sync events with correct environment tag

---

## 4. Deployment

### Environment Variables

| Variable | Staging | Production |
|----------|---------|------------|
| `QUICKBOOKS_CLIENT_ID` | Sandbox app ID | Production app ID (post-approval) |
| `QUICKBOOKS_CLIENT_SECRET` | Sandbox secret | Production secret |
| `QUICKBOOKS_REDIRECT_URI` | `https://staging.tellsight.app/api/integrations/quickbooks/callback` | `https://tellsight.app/api/integrations/quickbooks/callback` |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` | `production` |
| `ENCRYPTION_KEY` | Unique 64-char hex (staging-only) | Unique 64-char hex (never shared with staging) |

### Staging Environment

| Component | Staging | Production |
|-----------|---------|------------|
| Database | `analytics_staging` (separate DB or instance) | `analytics` |
| Redis | Separate instance or DB index `/1` | Default `/0` |
| QB App | Intuit sandbox app | Intuit production app |
| Domain | `staging.tellsight.app` or Vercel preview URL | `tellsight.app` |
| Sentry | Same project, `environment: 'staging'` | `environment: 'production'` |
| Stripe | Existing test mode keys | Production keys |
| Encryption key | Different from production | Unique, secrets manager |

### Staging Validation (run before each production deploy)
1. Fresh deploy, API boots, migrations run, seed loads
2. Connect QB sandbox, full OAuth flow succeeds
3. Initial sync, `data_rows` count matches sandbox company
4. Manual sync, incremental, no duplicates
5. Stale nudge visible on dashboard
6. Refresh insights, AI summary regenerates
7. Disconnect, connection removed, data persists
8. Reconnect, no duplicate rows
9. Run Playwright E2E suite against staging URL
10. Check Sentry, sync events appear with `environment: 'staging'`

### CI Pipeline Changes

The existing pipeline (`.github/workflows/ci.yml`) has 6 stages:
1. `quality`, lint + type-check
2. `test-shared-web`, shared + web unit tests
3. `test-api`, API Vitest tests (continue-on-error, memory constrained)
4. `seed-validation`, curation pipeline snapshot validation
5. `e2e`, Playwright tests against Docker Compose stack
6. `docker-smoke`, Docker smoke test

**What changes:**

**Stage 3 (`test-api`)**, no config change. The ~35 new mocked QB integration tests are standard Vitest files in `apps/api/`. They run automatically in the existing `npx vitest run` command. The `NODE_OPTIONS=--max-old-space-size=4096` already handles memory. The `continue-on-error: true` flag stays until the runner memory issue is resolved.

**Stage 5 (`e2e`)**, no config change. The 25 new QB Playwright tests go in `apps/web/e2e/quickbooks.spec.ts`. The existing step runs `npx playwright test` which picks up all `*.spec.ts` files. Docker Compose starts the full stack (web + api + db + redis), so the QB routes are available. The mocked API responses via `page.route()` intercept before the real API, so no QB credentials needed in `.env.ci`.

**New file: `.env.ci` additions:**
```
# QuickBooks, not configured in CI, API boots without it (guarded by isQbConfigured)
# No QUICKBOOKS_* vars needed
```
No changes to `.env.ci`, the QB env vars are already optional in `config.ts`. The API boots fine without them. The Playwright tests mock all QB endpoints client-side.

**New workflow: `deploy-staging.yml` (separate file):**
```yaml
name: Deploy Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Deploy to Staging
    needs: []  # runs independently of CI
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v5
      - name: Deploy to Vercel (staging)
        run: vercel deploy --prebuilt --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```
Staging deploys on every push to `main`. Production promotion is manual via `vercel promote` or the Vercel dashboard.

**No changes needed to:**
- Stage 1 (`quality`), lint/type-check picks up new files automatically
- Stage 2 (`test-shared-web`), QB tests are in API and e2e, not shared/web
- Stage 4 (`seed-validation`), QB doesn't affect seed data
- Stage 6 (`docker-smoke`), existing smoke test covers API health, which includes the QB-guarded startup path

**Playwright config addition:**
If `playwright.config.ts` doesn't already include `apps/web/e2e/` as a test directory, add it. Otherwise no change, the existing `npx playwright test` command discovers spec files automatically.

### Intuit App Review

**Pre-submission requirements:**
- Privacy policy at `tellsight.app/privacy`, what QB data is accessed, how stored, how deleted
- Terms of service at `tellsight.app/terms`
- App listing: description, target audience, data scope
- 3-5 screenshots: OAuth consent, integrations page (connected), dashboard with QB data
- Demo video (2-3 min): connect, sync, dashboard, disconnect

**Scope request:**
- `com.intuit.quickbooks.accounting`, read-only
- Do not request write, payroll, or payments scopes

**What reviewers check:**
- State cookie CSRF on OAuth (implemented)
- Token encryption at rest (AES-256-GCM, implemented)
- Token refresh handling (mutex, implemented)
- Disconnect revokes tokens (implemented)
- Error handling for declined consent (implemented)

**Timeline:**
- Initial review: 2-4 weeks
- Common rejection: missing privacy policy, too many scopes, no token revocation
- Re-review after fixes: 1-2 weeks
- Once approved, swap sandbox credentials for production keys

**Prep work that can start now (no code needed):**
- Draft privacy policy and terms of service pages
- Create Intuit developer account and sandbox app
- Screenshots and demo video come after frontend stories ship

---

## 5. Error Monitoring

### Layer 1: Sentry Breadcrumbs on Sync Lifecycle

Add structured breadcrumbs at each sync stage in `services/integrations/quickbooks/sync.ts`. When a failure reaches Sentry, the breadcrumb trail shows exactly where it broke.

| Stage | Breadcrumb | Data |
|-------|-----------|------|
| Job picked up | `sync.started` | `orgId`, `connectionId`, `trigger` |
| QB API fetch | `sync.fetch` | `entityType`, `rowCount`, `durationMs` |
| Normalize | `sync.normalize` | `inputRows`, `outputRows`, `skippedRows` |
| Upsert | `sync.upsert` | `insertedCount`, `updatedCount`, `batchNumber` |
| Stale mark | `sync.stale` | `orgId`, `summaryId` |
| Complete | `sync.completed` | `totalRows`, `durationMs` |
| Failed | `sync.failed` | `error`, `stage`, `retryCount` |

### Layer 2: Sentry Alerts (configured in Sentry dashboard)

| Alert | Condition | Severity |
|-------|-----------|----------|
| Token revoked | `TokenRevokedError` exception | Page oncall, user needs to reconnect |
| Sync failure spike | >3 failures in 1 hour | Notify, possible QB API outage or bad deploy |
| Slow sync | Duration >5 minutes | Warn, rate limits or large dataset |

### Layer 3: Admin Dashboard Sync Health Panel

Add to the existing `/admin` health monitoring page:

- **Active connections**, count of orgs with QB connected
- **Last 24h syncs**, successful / failed / pending counts
- **Oldest successful sync**, flag if any org >48 hours since last success
- **Recent errors**, last 5 failed sync jobs (org name, error, timestamp)

### What NOT to Alert On
- Individual sync successes (Pino logs cover this)
- OAuth connection attempts (analytics events cover this)
- Token refresh events (normal lifecycle, not errors)

---

## Implementation Order

1. **QB-8:** Upload page dual onboarding (side-by-side cards)
2. **QB-9:** Dashboard stale nudge (inline amber footer)
3. **QB-10:** Sentry breadcrumbs on sync lifecycle + admin panel sync health
4. **QB-11:** Integration tests (mocked QB API, ~30-40 Vitest tests)
5. **QB-12:** Playwright E2E tests (25 tests)
6. **QB-13:** Staging deployment + sandbox validation checklist
7. **QB-14:** Intuit app review prep (privacy policy, terms, screenshots, demo video)

Stories 1-5 are code. Stories 6-7 are ops/content.
