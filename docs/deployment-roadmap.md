# Deployment Roadmap

Where this project stands relative to production deployment, and what it would take to get there.

> **Active deploy**: execution is tracked in `_bmad-output/implementation-artifacts/tech-spec-production-deployment.md` (status: ready-for-dev, target 2026-05-04). Operational playbook: [`deploy-runbook.md`](./deploy-runbook.md).

## Current State: Portfolio-Ready

The app runs locally via `docker compose up` with zero configuration. Seed data, pre-cached AI summary, migrations, and dual-role PostgreSQL all initialize automatically. A hiring manager can clone, run one command, and see a working product.

**What works today:**
- Multi-stage Docker builds (slim production images, `node:22-slim`)
- Next.js standalone output (self-contained `server.js`, no `node_modules`)
- Entrypoint runs migrations + seed automatically (idempotent)
- Health endpoint (`/health`) checks DB + Redis, returns 503 on degradation
- 5-stage CI pipeline: lint/typecheck → Vitest → seed validation → Playwright E2E → Docker smoke
- Zod-validated config — app refuses to start with missing or invalid env vars
- BFF proxy — browser never talks to Express directly, same-origin, no CORS

## Recommended Production Topology

```mermaid
graph LR
    Browser -->|HTTPS| Vercel[Vercel<br/>Next.js 16]
    Vercel -->|Internal| Railway[Railway/Fly<br/>Express 5 API]
    Railway --> PG[Neon/Supabase<br/>PostgreSQL 18]
    Railway --> Redis[Upstash<br/>Redis 7]
    Railway -->|SSE| Claude[Claude API]
    Railway --> Stripe[Stripe API]
    Vercel --> Google[Google OAuth]
```

| Service | Recommended Provider | Why |
|---------|---------------------|-----|
| **Frontend** | Vercel | Native Next.js support, edge network, preview deployments |
| **API** | Railway or Fly.io | Docker container hosting, persistent processes for SSE streaming |
| **PostgreSQL** | Neon or Supabase | Managed Postgres with connection pooling, branching (Neon), or built-in auth tooling (Supabase) |
| **Redis** | Upstash | Serverless Redis, pay-per-request, global replication |
| **AI** | Anthropic (direct) | Claude API via `@anthropic-ai/sdk` — already integrated |
| **Payments** | Stripe | Already integrated — switch from test to live keys |
| **Auth** | Google OAuth | Already integrated — add production redirect URI |

## Environment Variables for Production

All variables validated by Zod at startup (`apps/api/src/config.ts`). App won't start if any are missing.

```bash
# Database — dual-role for RLS enforcement
DATABASE_URL=postgresql://app_user:$PASS@host:5432/analytics
DATABASE_ADMIN_URL=postgresql://app_admin:$PASS@host:5432/analytics

# Redis — rate limiting
REDIS_URL=redis://default:$PASS@host:6379

# Claude API — optional for seed-only demo, required for live AI
CLAUDE_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-5-20250929  # default, configurable

# Stripe — switch test keys to live
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Google OAuth — add production redirect URI in Google Console
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Auth
JWT_SECRET=<64+ char random string>  # min 32, recommend 64 for production

# App
APP_URL=https://yourdomain.com
NODE_ENV=production
PORT=3001
```

## Dual-Role Database Setup

Production Postgres needs two roles, matching `docker/init.sql`:

```sql
-- app_user: RLS enforced, used by application queries
CREATE ROLE app_user LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE analytics TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- app_admin: BYPASSRLS, used for migrations, seed, admin queries, webhooks
ALTER ROLE app_admin BYPASSRLS;
```

Managed Postgres providers (Neon, Supabase) support custom roles. Create both during initial setup.

## What's Missing for Production

### Blocking — Must Have Before Live Users

| Gap | Impact | Effort |
|-----|--------|--------|
| ~~**Graceful shutdown**~~ | ~~No `SIGTERM`/`SIGINT` handlers.~~ | ✅ Done — SIGTERM/SIGINT handlers with 30s drain timeout in `index.ts` |
| ~~**Per-tier AI usage quota**~~ | ~~Free users can burn unlimited input tokens.~~ | ✅ Done — free: 3/month, pro: 100/month, 402 QuotaExceededError |
| ~~**Dataset row limit**~~ | ~~`getRowsByDataset()` fetches ALL rows.~~ | ✅ Done — 50k CSV_MAX_ROWS enforced at preview endpoint |
| ~~**Non-root Docker user**~~ | ~~Containers run as root.~~ | ✅ Done — `USER node` + `chown` in both Dockerfiles |
| ~~**Dockerfile health check**~~ | ~~Container orchestrators can't detect unhealthy app state.~~ | ✅ Done — `HEALTHCHECK` with curl in both Dockerfiles |

### High Priority — Should Have Before Scaling

| Gap | Impact | Effort |
|-----|--------|--------|
| **Error tracking (Sentry)** | Errors go to stdout only. Can't diagnose production issues without aggregation, stack traces, and alerting. | Small — `@sentry/node` + `@sentry/nextjs`, wrap error handler |
| ~~**AI usage metrics**~~ | ~~Can't manage LLM costs.~~ | ✅ Done — inputTokens, outputTokens, tier, computationTimeMs in AI_SUMMARY_COMPLETED events |
| **Circuit breaker on Claude API** | If Claude is down, every AI request fails with timeout. No graceful degradation. | Medium — return cached summary or "AI temporarily unavailable" |
| **Connection pooler** | DB pool at `max: 10` per process. Fine for dozens of users, not hundreds. | Medium — add PgBouncer or use Neon's built-in pooler |
| **Account lockout** | No throttling on failed login attempts. Brute-force possible on auth endpoints. | Small — track failures in Redis, lock after N attempts |

### Medium Priority — Nice to Have

| Gap | Impact | Effort |
|-----|--------|--------|
| ~~**Deployment pipeline**~~ | ~~CI runs tests but doesn't deploy.~~ | ✅ Done — `deploy` job appended to `.github/workflows/ci.yml`, fires Railway + Vercel hooks after `docker-smoke` on `main` |
| ~~**Readiness vs liveness probes**~~ | ~~Single `/health` endpoint.~~ | ✅ Done — `/health/live` (no deps) + `/health/ready` (DB + Redis) + legacy `/health` in `apps/api/src/routes/health.ts` |
| **Secrets rotation guide** | No docs on how to rotate JWT_SECRET, API keys without downtime. | Small — document the process |
| **Performance monitoring** | No P95 latency tracking, no TTFB monitoring, no baseline. | Medium — Sentry performance or custom Pino metrics |
| **Horizontal scaling** | Single-process deployment only. Rate limiter in-memory fallbacks don't coordinate across instances. | Large — load balancer + Redis-only rate limiting |

## Deploy Checklist

For when you're ready to go live:

- [ ] Create production Postgres with dual roles (app_user + app_admin)
- [ ] Create production Redis instance
- [ ] Set all production env vars (see list above)
- [ ] Switch Stripe from test to live keys
- [ ] Add production redirect URI to Google OAuth Console
- [x] Add `HEALTHCHECK` to Dockerfiles
- [x] Add `USER node` to Dockerfiles
- [x] Add graceful shutdown handlers to `apps/api/src/index.ts`
- [x] Add per-tier AI usage quota
- [x] Add dataset row limit (50k)
- [x] Split `/health` into `/health/live` + `/health/ready`
- [x] Wrap migrations with advisory lock (`apps/api/src/db/migrate.ts`)
- [x] Set `trust proxy: 2` for BFF hop count (`apps/api/src/index.ts`)
- [x] Unify cookie flags via `COOKIE_DOMAIN` env var (`apps/api/src/lib/cookies.ts`)
- [x] Append deploy job to CI pipeline (`.github/workflows/ci.yml`)
- [ ] Deploy API container (Railway) — see `deploy-runbook.md`
- [ ] Deploy web to Vercel (connect repo, set env vars) — see `deploy-runbook.md`
- [ ] Configure Stripe webhook endpoint to production URL
- [ ] Run migrations against production DB
- [ ] Verify `/health/ready` returns 200
- [ ] Verify seed data loads correctly
- [ ] Verify OAuth login flow works end-to-end
- [ ] Set up error tracking (Sentry) — deferred to Week 2 spec
- [ ] Monitor first 24 hours of AI usage costs

## Cost Estimates

Rough monthly costs for a small deployment (< 100 users):

| Service | Estimated Cost |
|---------|---------------|
| Vercel (Hobby/Pro) | $0–20/mo |
| Railway (API container) | $5–20/mo |
| Neon (Postgres, free tier) | $0–19/mo |
| Upstash (Redis, free tier) | $0–10/mo |
| Claude API (with caching) | $5–50/mo depending on usage |
| Stripe | 2.9% + $0.30 per transaction |
| **Total** | **~$10–120/mo** |

The cache-first AI architecture is the biggest cost lever. Most dashboard views hit the cache (free). Only new dataset uploads or stale cache invalidations trigger Claude calls.
