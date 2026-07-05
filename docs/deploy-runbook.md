# Deploy Runbook

Operational guide for the deployed production stack (Vercel + Railway + Neon + Upstash + Cloudflare). This doc is what you reach for after the stack is live.

**Crisis mode cheat sheet:**

```bash
# See what broke
railway logs --service api | tail -50
vercel logs --follow <deployment-url>

# Roll back
# Railway: dashboard → service api → Deployments → previous → "Redeploy"
# Vercel:  dashboard → project → Deployments → previous → "Promote to Production"

# Check health
curl -fsS https://{DOMAIN}/api/health/ready | jq
```

---

## 0. First-Time Provisioning

Everything above assumes the stack already exists. This section stands it up the first time. The CI `deploy` job only fires hooks at already-provisioned Vercel + Railway projects, so the first deploy is manual.

### Managed-Postgres RLS gotcha (read first)

`docker/init.sql` runs `ALTER ROLE app_admin BYPASSRLS`, which needs **superuser**. Neon and RDS do **not** grant superuser, so that line fails there. You do not need it: the RLS policies use `ENABLE ROW LEVEL SECURITY`, not `FORCE`, so the **table owner bypasses RLS by ownership**. Requirements on managed Postgres:

- Run migrations as the **owner** role, and use that same role as `DATABASE_ADMIN_URL`. Ownership gives it the RLS bypass (matches `seed.ts`, which assumes admin bypasses RLS with no `SET LOCAL`).
- `app_user` is a **separate, non-owner** role with DML grants only. It is subject to RLS, isolated per request by `app.current_org_id`.
- Skip the `BYPASSRLS` line. Do not put the app's tables under `FORCE ROW LEVEL SECURITY`, or ownership stops bypassing.

`app_user` grants (managed-safe, drop the `BYPASSRLS` line from `init.sql`):

```sql
CREATE ROLE app_user LOGIN PASSWORD '<pass>';
GRANT CONNECT ON DATABASE <db> TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
```

### Required env vars (14, all validated fail-fast by `config.ts`)

The app refuses to boot if any are missing. `CLAUDE_API_KEY` is **required** (not optional, despite older docs) because the cache keeps usage low, not the config lax. Because the dashboard is public, the demo renders with zero login, so Stripe/Google only need to be present to boot, not functional.

```bash
# API (Railway)
DATABASE_URL=postgresql://app_user:PASS@<host>/<db>?sslmode=require        # restricted, non-owner
DATABASE_ADMIN_URL=postgresql://<owner>:PASS@<host>/<db>?sslmode=require   # owns tables -> RLS bypass
REDIS_URL=rediss://default:PASS@<upstash-host>:6379
CLAUDE_API_KEY=sk-ant-...
STRIPE_SECRET_KEY=sk_test_...            # test mode is fine
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
GOOGLE_CLIENT_ID=...                     # add the production redirect URI in Google Console
GOOGLE_CLIENT_SECRET=...
JWT_SECRET=<openssl rand -base64 48>
APP_URL=https://<app>.vercel.app
NODE_ENV=production
EMAIL_FROM_ADDRESS=demo@yourdomain.dev   # EMAIL_PROVIDER defaults to console; nothing sends
EMAIL_MAILING_ADDRESS=123 Demo St, City, ST   # CAN-SPAM field

# Web (Vercel)
PUBLIC_API_URL=https://<api>.up.railway.app
```

Everything else (`CLAUDE_MODEL`, `PORT`, `EMAIL_PROVIDER`, `ANALYTICS_RETENTION_DAYS`, Sentry, Resend, QuickBooks, `METRICS_TOKEN`, `COOKIE_DOMAIN`) has a default or is optional.

### Ordered steps

1. **Postgres (Neon or Supabase):** create the DB; create `app_user` (restricted) with the grants above; confirm the owner role for `DATABASE_ADMIN_URL`. Skip `BYPASSRLS`.
2. **Redis (Upstash):** create the DB; copy the `rediss://` URL.
3. **API (Railway):** deploy `apps/api` via its Dockerfile; paste the 14 vars. The entrypoint runs migrations + seed automatically (idempotent, advisory-locked).
4. **Web (Vercel):** import the repo, root `apps/web`; set `PUBLIC_API_URL` + `APP_URL`.
5. **Verify:** `curl -fsS https://<app>.vercel.app/api/health/ready | jq` returns `{"status":"ok"}`; open the dashboard and confirm charts + the pre-cached AI summary render with no login.
6. **Wire auto-deploy:** set repo secrets `VERCEL_DEPLOY_HOOK_URL`, `RAILWAY_DEPLOY_HOOK_URL`, `PRODUCTION_URL`. The `deploy` job then activates on every push to `main`.
7. **Demo link:** point the README/profile demo URL at the live `*.vercel.app` (custom domain optional; do it later).

---

## 1. How to Deploy

### Automatic (normal path)

Merging a PR to `main` triggers the full CI pipeline. The `deploy` job fires after `docker-smoke` passes, no manual action needed. Sequence:

1. GitHub Actions runs quality → test-shared-web → seed-validation → e2e → docker-smoke
2. `deploy` job fires Vercel deploy hook, then Railway deploy hook
3. Post-deploy health poll waits up to 5 minutes for `https://{DOMAIN}/api/health/ready` to return `{"status":"ok"}`
4. CI turns green when health is confirmed

Watch the Actions tab for live status. If health poll fails, the job red-Xs but the deploy has already landed, investigate via logs before reverting.

### Manual deploy (force a redeploy)

Cases: env var change needs a container restart, previous deploy was skipped, want to deploy without a code change.

```bash
# Vercel
vercel --prod

# Railway
railway up --service api
```

Both CLIs require prior auth (`vercel login`, `railway login`). Both respect the linked project/service.

### Required GitHub Actions secrets

| Secret | Source | Purpose |
| ------ | ------ | ------- |
| `VERCEL_DEPLOY_HOOK_URL` | Vercel project → Settings → Git → Deploy Hooks | Triggers a Vercel production build |
| `RAILWAY_DEPLOY_HOOK_URL` | Railway service → Settings → Deploy Triggers | Triggers a Railway container rebuild |
| `PRODUCTION_URL` | e.g. `https://tellsight.com` | Target of the post-deploy health poll |

Set these in repo Settings → Secrets and variables → Actions. Missing secrets cause the `deploy` job to silently skip or fail fast.

---

## 2. How to Roll Back

Three rollback axes, each independent. Pick the one that matches the failure.

### A. App rollback (Vercel)

1. Vercel dashboard → project → Deployments tab
2. Find the last known-good deployment (green check)
3. Three-dot menu → **Promote to Production**
4. TTL: under 60 seconds, no rebuild

Use when: frontend regression, bad env var, broken build picked up a stale API.

### B. App rollback (Railway)

1. Railway dashboard → service `api` → Deployments tab
2. Find the previous successful deployment
3. **Redeploy** button
4. TTL: 60-90 seconds, includes container restart + migration lock acquisition

Use when: API regression, bad env var, dependency conflict.

### C. Database rollback (Neon branch restore)

Destructive. Only use when the fix cannot roll forward (bad migration, data corruption, wrong tenant writes).

1. Neon dashboard → project → Branches tab
2. Find a branch or snapshot from before the incident (PITR window covers up to your retention tier, check tier)
3. **Restore** or create a new branch from that point
4. Update `DATABASE_URL` + `DATABASE_ADMIN_URL` on Railway to the restored branch's pooler connection strings
5. Redeploy Railway (picks up new env)

Use when: schema migration can't be reversed, seed regression, data-layer corruption. Verify PITR retention covers your incident window before attempting.

### D. Combined rollback

Bad release that touched schema + code: roll DB back first (Neon), then roll app back (Railway + Vercel). Always DB first, the app expects the schema it was built against.

---

## 3. How to Observe

### Real-time log tailing

```bash
# API (Express, Pino structured logs)
railway logs --service api

# Frontend (Vercel serverless functions + build logs)
vercel logs <deployment-url> --follow
```

Both support `--help` for filters, durations, and output formats. Tailing costs nothing, run them liberally.

### Health probes

```bash
# Liveness (lightweight, no deps)
curl -fsS https://{DOMAIN}/api/health/live

# Readiness (checks DB + Redis)
curl -fsS https://{DOMAIN}/api/health/ready | jq

# Direct to Railway (bypasses Vercel, useful for triaging proxy vs API)
curl -fsS https://api.{DOMAIN}/health/ready | jq
```

If `/health/ready` returns 503, the body tells you which service degraded (DB or Redis). `/health/live` going red means the process itself is dead, check Railway deployment logs.

### Metrics endpoint (bearer-gated in prod)

```bash
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://api.{DOMAIN}/metrics
```

Returns Prometheus-format metrics including `http_request_duration_seconds` histogram by method/route/status. Useful for ad-hoc latency triage before Sentry lands.

### When Sentry activates (Week 2)

This section gets replaced. Sentry dashboards become the primary observability surface; CLI log tailing becomes the fallback.

---

## 4. How to Rotate Secrets

All rotations follow the same pattern: update in the source-of-truth provider, then update the env var on Railway/Vercel, then redeploy.

### `JWT_SECRET`

**Impact**: every user re-authenticates. No grace-period overlap, a single secret is in force at any moment. Schedule during low-traffic window.

1. Generate: `openssl rand -base64 48`
2. Update Railway: Variables → `JWT_SECRET` → new value → Save
3. Update Vercel: Settings → Environment Variables → `JWT_SECRET` (Production scope) → new value → Save
4. Redeploy both (Railway auto-redeploys on var change; Vercel needs manual trigger or next git push)
5. Verify post-deploy: log in from a fresh browser, confirm dashboard loads

Vercel and Railway **must** share the exact same value. Drift between the two breaks JWT verification in `proxy.ts`.

### `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`

**Impact**: short window where in-flight Checkout sessions can fail. Schedule around known-low billing activity.

1. Stripe dashboard → Developers → API keys → Roll secret key
2. Update Railway: `STRIPE_SECRET_KEY` = new `sk_live_*`
3. Stripe dashboard → Developers → Webhooks → your endpoint → **Roll signing secret**
4. Update Railway: `STRIPE_WEBHOOK_SECRET` = new `whsec_*`
5. Redeploy Railway (single redeploy covers both)
6. Trigger a test webhook from Stripe; confirm signature verification succeeds in Railway logs

Never roll the webhook secret without also updating Railway in the same window, signature verification fails silently until the env var catches up.

### `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET`

**Impact**: digest sends pause briefly during the API key swap; bounce/complaint webhooks 400 until the secret update lands. Schedule around the Sunday 18:00 UTC cron tick.

1. Resend dashboard → API Keys → roll the key → copy
2. Update Railway: `RESEND_API_KEY` = new `re_*`
3. Resend dashboard → Webhooks → your `/webhooks/resend` endpoint → roll the signing secret
4. Update Railway: `RESEND_WEBHOOK_SECRET` = new `whsec_*`
5. Redeploy Railway (single redeploy covers both)
6. Send yourself a test email via the Resend dashboard, confirm `email.delivered` arrives at `/webhooks/resend` with a 200

Both vars must update in the same window. The webhook route registers unconditionally; if the secret is absent or stale, every Svix-signed request fails verification and the bounce/complaint feedback loop is dark.

### `CLAUDE_API_KEY`

**Impact**: any in-flight AI summary request fails mid-stream during the key swap window (< 10 seconds).

1. Anthropic Console → API Keys → create new key → copy
2. Update Railway: `CLAUDE_API_KEY` = new key → Save (Railway redeploys)
3. Verify: trigger a fresh AI summary, confirm stream completes
4. Revoke old key in Anthropic Console once the new one is proven

Only Railway holds this key. Never add it to Vercel.

### `GOOGLE_CLIENT_SECRET`

**Impact**: new OAuth logins fail during swap. Existing sessions unaffected (JWT-based, not OAuth-token-based).

1. Google Cloud Console → APIs & Services → Credentials → your OAuth client → Reset secret
2. Update Railway: `GOOGLE_CLIENT_SECRET` = new value
3. Redeploy Railway
4. Test: log out, log back in with Google, confirm redirect round-trip succeeds

### Database passwords (`app_user`, `app_admin`)

**Impact**: all DB connections drop during rotation.

1. Neon dashboard → Roles → pick role → Reset password
2. Update Railway: `DATABASE_URL` (for `app_user`) or `DATABASE_ADMIN_URL` (for `app_admin`) with new password
3. Railway redeploys automatically; API reconnects with new credentials

Rotate one role at a time. If both fail simultaneously, the API can't acquire any DB connection and health probes return 503.

### `COOKIE_DOMAIN`

Not a secret, but configuration. Changing it breaks every active session (cookies bound to the old domain become unreachable).

1. Update Railway: `COOKIE_DOMAIN` = new value (or unset to fall back to host-only)
2. Redeploy Railway
3. All users re-authenticate on next request

Only rotate if the domain itself is changing.

---

## Appendix: Known Limitations

- **JWT rotation forces re-login**, no dual-secret overlap. This is an accepted trade-off; dual-secret rotation would add deployment complexity for marginal benefit at current scale. Future enhancement: grace-period rotation that accepts both the old and new secret for N minutes.
- **Railway deploy job is fire-and-forget**, the GitHub Actions `deploy` job returns success when the hook accepts the trigger, not when the container is healthy. The 5-minute health poll catches most failures but cannot distinguish "deploy pending" from "deploy started". Upgrade to polling Railway's deployment status API post-launch if stability warrants.
- **Single-region deployment**, Railway us-east, Neon us-east-2, Upstash us-east-1. Cross-region failover is not wired. If any provider's us-east has a regional outage, the app is down. Multi-region is a post-launch scaling decision, not a Day 1 requirement.
