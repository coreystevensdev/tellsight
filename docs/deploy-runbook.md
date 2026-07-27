# Deploy Runbook

Operational guide for the deployed production stack (single free-tier EC2 t2.micro + RDS + ECR + Caddy, see `infra/README.md`). This doc is what you reach for after the stack is live; `infra/README.md` is what you reach for to stand it up the first time.

**Crisis mode cheat sheet:**

```bash
# See what broke (SSM session, no SSH key needed)
aws ssm start-session --target <instance_id>
docker compose -f /opt/tellsight/docker-compose.yml logs api --tail 50
docker compose -f /opt/tellsight/docker-compose.yml logs web --tail 50

# Roll back: on the instance, pin the previous image tag in docker-compose.yml, then
docker compose pull && docker compose up -d --remove-orphans

# Check health
curl -fsS https://{PRODUCTION_DOMAIN}/api/health/ready | jq
```

---

## 0. First-Time Provisioning

See `infra/README.md` for the full first-time setup (Terraform apply, the one-time `infra/rds-init.sql` role setup, GitHub Actions secrets, first deploy). That doc is the source of truth for provisioning; this one assumes the stack already exists.

### Required env vars (written to `/opt/tellsight/.env` by `deploy-aws.yml`, validated fail-fast by `config.ts`)

The app refuses to boot if any required var is missing. `CLAUDE_API_KEY` is required (not optional) because the cache keeps usage low, not the config lax.

```bash
DATABASE_URL=postgresql://app_user:PASS@<rds-endpoint>:5432/analytics        # restricted, RLS enforced
DATABASE_ADMIN_URL=postgresql://app_admin:PASS@<rds-endpoint>:5432/analytics # RDS master, RLS bypassed
CLAUDE_API_KEY=sk-ant-...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
GOOGLE_CLIENT_ID=...                     # add the production redirect URI in Google Console
GOOGLE_CLIENT_SECRET=...
JWT_SECRET=<openssl rand -hex 32>
APP_URL=https://<eip_public_dns>
PUBLIC_API_URL=https://<eip_public_dns>
NODE_ENV=production
EMAIL_PROVIDER=resend                    # console is rejected in production
EMAIL_FROM_ADDRESS=<verified Resend sender>
EMAIL_FROM_NAME=<your real sender name>
EMAIL_MAILING_ADDRESS=<your real physical address>   # CAN-SPAM
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
METRICS_TOKEN=<openssl rand -hex 24>
```

`DATABASE_URL` and `DATABASE_ADMIN_URL` must be different roles, see `infra/rds-init.sql`, everything else has a default or is optional (`CLAUDE_MODEL`, `PORT`, `ANALYTICS_RETENTION_DAYS`, `SENTRY_DSN`, QuickBooks, `COOKIE_DOMAIN`).

---

## 1. How to Deploy

### Automatic (normal path)

Merging a PR to `main` triggers CI, then `deploy-aws.yml` fires on `workflow_run` once CI succeeds. Sequence:

1. GitHub Actions runs the `CI` workflow (quality → tests → e2e → docker-smoke)
2. `deploy-aws.yml` builds and pushes API + web images to ECR, writes `.env` and the real Caddyfile via SSM, pulls the new images, restarts containers
3. Smoke test polls `https://{PRODUCTION_DOMAIN}/api/health/ready` for up to 3 minutes

Watch the Actions tab for live status.

### Manual deploy (force a redeploy without a code change)

```bash
# Trigger the workflow manually from the Actions tab, or:
gh workflow run deploy-aws.yml
```

Or, for an env-only change (no image rebuild needed):

```bash
aws ssm start-session --target <instance_id>
cd /opt/tellsight && docker compose up -d --remove-orphans
```

### Required GitHub Actions secrets

See the full table in `infra/README.md` Step 5. Missing secrets cause the deploy job to fail with a clear `KeyError` on the missing `os.environ[...]` lookup rather than silently skip.

---

## 2. How to Roll Back

Two rollback axes, each independent. Pick the one that matches the failure.

### A. App rollback (pin a previous image)

1. `aws ssm start-session --target <instance_id>`
2. `aws ecr list-images --repository-name tellsight-api` (or `tellsight-web`) to find the previous `sha-...` tag
3. Edit `/opt/tellsight/docker-compose.yml`, pin the `image:` line to that tag
4. `docker compose pull && docker compose up -d --remove-orphans`
5. TTL: under a minute once you have the tag, most of the time is finding it in the ECR console

Use when: a bad deploy shipped a regression and you need the previous known-good image back immediately.

### B. Database rollback (RDS snapshot restore)

Destructive. Only use when the fix cannot roll forward (bad migration, data corruption, wrong tenant writes).

1. RDS console → your instance → Snapshots (automated snapshots run daily by default)
2. Restore to a new instance from a snapshot before the incident
3. Update `DATABASE_URL` + `DATABASE_ADMIN_URL` GitHub Actions secrets to point at the restored instance's endpoint
4. Re-run `infra/rds-init.sql` against the restored instance if it predates the `app_user` role setup
5. Trigger a manual deploy so the running containers pick up the new secrets

Use when: schema migration can't be reversed, seed regression, data-layer corruption. RDS automated snapshots default to a 7-day retention window, verify that covers your incident before relying on it.

### C. Combined rollback

Bad release that touched schema + code: restore the DB first, then roll the app back. Always DB first, the app expects the schema it was built against.

---

## 3. How to Observe

### Real-time log tailing

```bash
aws ssm start-session --target <instance_id>
docker compose -f /opt/tellsight/docker-compose.yml logs api --follow
docker compose -f /opt/tellsight/docker-compose.yml logs web --follow
```

### Health probes

```bash
curl -fsS https://{PRODUCTION_DOMAIN}/api/health/live
curl -fsS https://{PRODUCTION_DOMAIN}/api/health/ready | jq
```

If `/health/ready` returns 503, the body names which dependency degraded (DB or Redis). `/health/live` going red means the process itself is dead, check the container logs.

### Metrics endpoint (bearer-gated in prod)

```bash
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://{PRODUCTION_DOMAIN}/metrics
```

### Grafana + Prometheus

Not deployed on the free-tier EC2 instance, 1 GB RAM doesn't reliably fit them alongside redis/api/web. Local dev's `docker-compose.yml` still runs the full stack. See `infra/README.md` if you resize to `t3.small` and want them live in production too.

---

## 4. How to Rotate Secrets

All rotations follow the same pattern: update the value in the source-of-truth provider, update the GitHub Actions secret, then trigger a manual deploy (Step 1) so the new value actually reaches `/opt/tellsight/.env`.

### `JWT_SECRET`

**Impact**: every user re-authenticates, no grace-period overlap. Schedule during a low-traffic window.

1. `openssl rand -hex 32`
2. Update the `JWT_SECRET` GitHub Actions secret
3. Trigger a manual deploy
4. Verify: log in from a fresh browser, confirm the dashboard loads

### `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`

1. Stripe dashboard → Developers → API keys → Roll secret key → update the secret
2. Stripe dashboard → Developers → Webhooks → your endpoint → Roll signing secret → update the secret
3. Trigger a manual deploy
4. Trigger a test webhook from Stripe, confirm signature verification succeeds in the API logs

### `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET`

1. Resend dashboard → API Keys → roll the key → update the secret
2. Resend dashboard → Webhooks → your `/webhooks/resend` endpoint → roll the signing secret → update the secret
3. Trigger a manual deploy
4. Send a test email via the Resend dashboard, confirm `email.delivered` arrives at `/webhooks/resend` with a 200

Both vars must update together, the webhook route registers unconditionally, a stale secret fails every Svix-signed request until it's updated.

### `CLAUDE_API_KEY`

1. Anthropic Console → API Keys → create new key
2. Update the secret, trigger a manual deploy
3. Verify: trigger a fresh AI summary, confirm the stream completes
4. Revoke the old key in the Anthropic Console once the new one is proven

### `GOOGLE_CLIENT_SECRET`

1. Google Cloud Console → APIs & Services → Credentials → your OAuth client → Reset secret
2. Update the secret, trigger a manual deploy
3. Test: log out, log back in with Google, confirm the redirect round-trip succeeds

### Database passwords (`app_user`, `app_admin`)

**Impact**: all DB connections drop during rotation.

1. RDS console → Modify → new master password (for `app_admin`), or `ALTER ROLE app_user PASSWORD '...'` via the SSM port-forward for `app_user`
2. Update `DATABASE_URL` and/or `DATABASE_ADMIN_URL` GitHub Actions secrets
3. Trigger a manual deploy

Rotate one role at a time. If both fail simultaneously, the API can't acquire any DB connection and health probes return 503.

---

## Appendix: Known Limitations

- **No dual-secret rotation.** `JWT_SECRET` rotation forces every user to re-authenticate immediately, no grace-period overlap. Accepted trade-off at current scale.
- **Single instance, no HA.** One EC2 box, one RDS instance, no ALB/multi-AZ. If the instance or its AZ goes down, the app is down until it's replaced. Multi-AZ RDS and an ALB are a post-launch scaling decision, not a Day 1 requirement, given the cost trade-off (roughly doubles infra spend).
- **SSM-based deploy has no rollback-on-failure.** `docker compose up -d` runs and the smoke test polls after, but if the new image crash-loops, nothing automatically reverts to the previous image, that's the manual rollback path in section 2A.
- **Single region.** Everything runs in `us-east-1`. A regional AWS outage takes the whole app down. Not wired for cross-region failover.
- **No live observability.** Prometheus and Grafana run in local dev only, dropped from this deploy target to fit the free-tier `t2.micro`'s 1 GB RAM. Production visibility is limited to health probes, `/metrics`, and container logs until the instance is resized.
