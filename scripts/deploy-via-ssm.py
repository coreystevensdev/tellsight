#!/usr/bin/env python3
"""Build and execute the production SSM deployment command."""

import base64, json, os, subprocess, sys, time

domain = os.environ['PRODUCTION_DOMAIN']

# Single quotes, because compose and a shell that sources this file
# agree on them: whitespace preserved, no $ expansion. Double quotes are
# not equivalent, both consumers expand $ inside them. Bare was the bug:
# EMAIL_MAILING_ADDRESS went out unquoted, so `. ./.env` read its second
# word as a command.
def env_line(key, value):
    value = str(value)
    # Compose has no escape for a single quote inside a single-quoted
    # value. The shell form ('"'"') breaks its parser outright and takes
    # the whole file with it, so refuse rather than ship an unreadable
    # .env and an API that cannot boot.
    if "'" in value or "\n" in value:
        sys.exit(f"{key} contains a quote or newline, which docker compose cannot represent in an env_file")
    # An unset repository secret arrives as "", not absent, so
    # os.environ[key] hands back an empty string instead of raising.
    # Without this the deploy writes KEY='', pulls both images, and
    # only falls over when migrate.ts loads config on the instance.
    if not value:
        sys.exit(f"{key} is empty. Set the repository secret; the deploy will not write a blank required value.")
    return f"{key}='{value}'"

env_pairs = [
    ("NODE_ENV", "production"),
    # Short sha, matching the image tag the drift gate compares.
    ("BUILD_SHA", os.environ['HEAD_SHA'][:7]),
    ("DATABASE_URL", os.environ['DATABASE_URL']),
    ("DATABASE_ADMIN_URL", os.environ['DATABASE_ADMIN_URL']),
    ("CLAUDE_API_KEY", os.environ['CLAUDE_API_KEY']),
    ("CLAUDE_MODEL", os.environ.get('CLAUDE_MODEL') or 'claude-sonnet-4-6'),
    # Only written when set: unset means one model for every path.
    *( [("CLAUDE_MODEL_TOOLS", os.environ['CLAUDE_MODEL_TOOLS'])] if os.environ.get('CLAUDE_MODEL_TOOLS') else [] ),
    ("STRIPE_SECRET_KEY", os.environ['STRIPE_SECRET_KEY']),
    ("STRIPE_WEBHOOK_SECRET", os.environ['STRIPE_WEBHOOK_SECRET']),
    ("STRIPE_PRICE_ID", os.environ['STRIPE_PRICE_ID']),
    # A repo variable, not a secret: it carries no credential, and the
    # whole point is that running Stripe in test mode here is a stated
    # choice rather than something inferred from a key prefix.
    ("STRIPE_TEST_MODE_IN_PRODUCTION", os.environ.get('STRIPE_TEST_MODE_IN_PRODUCTION') or 'false'),
    ("GOOGLE_CLIENT_ID", os.environ['GOOGLE_CLIENT_ID']),
    ("GOOGLE_CLIENT_SECRET", os.environ['GOOGLE_CLIENT_SECRET']),
    ("JWT_SECRET", os.environ['JWT_SECRET']),
    ("APP_URL", f"https://{domain}"),
    ("PUBLIC_API_URL", f"https://{domain}"),
    ("EMAIL_PROVIDER", "resend"),
    ("EMAIL_FROM_ADDRESS", os.environ['EMAIL_FROM_ADDRESS']),
    ("EMAIL_FROM_NAME", os.environ['EMAIL_FROM_NAME']),
    ("EMAIL_MAILING_ADDRESS", os.environ['EMAIL_MAILING_ADDRESS']),
    ("RESEND_API_KEY", os.environ['RESEND_API_KEY']),
    ("RESEND_WEBHOOK_SECRET", os.environ['RESEND_WEBHOOK_SECRET']),
    ("METRICS_TOKEN", os.environ['METRICS_TOKEN']),
    ("QUICKBOOKS_ENVIRONMENT", os.environ.get('QUICKBOOKS_ENVIRONMENT') or 'sandbox'),
    ("SQUARE_ENVIRONMENT", os.environ.get('SQUARE_ENVIRONMENT') or 'sandbox'),
]

# Every connector is fully optional (isQbConfigured / isShopifyConfigured
# / isSquareConfigured gate each one off when any of its keys is
# missing). config.ts's .optional() only skips validation when the key
# is absent entirely -- an empty string from an unset GitHub secret
# still fails z.string().url()/.length(64), so these are omitted rather
# than written as blank lines.
#
# Shopify and Square were absent from this list until 2026-09-15, which
# meant both connectors could ship, deploy and still never be turned on:
# the secrets had nowhere to travel. ENCRYPTION_KEY is shared by all
# three, since it encrypts the stored tokens.
for key in (
    "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REDIRECT_URI",
    "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_REDIRECT_URI",
    "SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET", "SQUARE_REDIRECT_URI",
    "ENCRYPTION_KEY",
):
    value = os.environ.get(key, "")
    if value:
        env_pairs.append((key, value))

env_lines = [env_line(k, v) for k, v in env_pairs]

# Base64-encode so no shell-quoting issues when the string hits the EC2 shell.
env_b64 = base64.b64encode(("\n".join(env_lines) + "\n").encode()).decode()
ecr_host = os.environ['ECR_API_REPO'].split('/')[0]

# The base compose on the instance pins both services to :latest, a
# moving tag. That is what let a failed pull leave the previous image
# runnable, so `up -d` restarted stale code and every check passed.
#
# An override file is compose's own merge mechanism, so this pins the
# exact build without restating the base. If the pull fails, the sha
# tag simply is not present locally and `up -d` fails instead of
# quietly serving whatever was there before.
#
# Written here rather than in terraform user_data because user_data
# only runs on first boot and carries ignore_changes. Same reason the
# Caddyfile is written from here.
short = os.environ['HEAD_SHA'][:7]
override = (
    "services:\n"
    "  api:\n"
    f"    image: {os.environ['ECR_API_REPO']}:sha-{short}\n"
    "  web:\n"
    f"    image: {os.environ['ECR_WEB_REPO']}:sha-{short}\n"
)
override_b64 = base64.b64encode(override.encode()).decode()

# /api/* must NOT be intercepted here -- Next.js owns that prefix.
# Its own route.ts files (auth/login, datasets, etc.) hold real BFF
# logic (cookie handling, session translation), and next.config.ts's
# rewrite() catches anything without a matching route.ts and proxies
# it to Express with /api stripped. Sending /api/* to Express
# directly from Caddy skips all of that -- it broke Google sign-in
# (browser calls /api/auth/login, a Next.js route; Caddy forwarded
# it as bare /login, which doesn't exist on Express) and would have
# broken every other BFF route the same way.
#
# Only two paths are legitimately external and never touch a
# browser session, so they bypass Next.js on purpose: the Stripe/
# Resend webhooks (server-to-server, need the raw body before
# Express's JSON parser) and the QuickBooks OAuth callback (Intuit
# redirects the user's browser straight to it; Next.js has no page
# there). Both are `handle` (not handle_path) because Express
# registers these exact paths unprefixed -- stripping would break
# the match, unlike /api/* where Express genuinely has no /api.
#
# Targets are api:3001/web:3000 (Docker Compose service DNS), not
# 127.0.0.1 -- caddy is a sibling container on the same compose
# network (ec2.tf), not a process on the host, so 127.0.0.1 inside
# the caddy container would mean the caddy container itself.
# Caddy already redirects http to https and renews the certificate on
# its own, so what was missing is HSTS: without it the very first
# request a browser makes to this host still goes out in the clear and
# the redirect itself is interceptable.
#
# One year, and deliberately no `preload`. Preload is a submission to a
# list baked into browser binaries, and getting back off it takes
# months, so it is a decision to make on purpose rather than a default
# to inherit from a snippet.
# The connector callbacks are the one browser-facing path that has to
# reach Express directly: the provider redirects the browser here and
# Next.js has no route file for it. This was pinned to quickbooks until
# 2026-09-15, so Shopify and Square both shipped with a callback that
# 404'd in production while returning 501 correctly everywhere else.
# A prefix rather than three literals, since the next connector would
# otherwise fail the same silent way. Safe as a prefix because Express
# mounts nothing but the callbacks at /integrations, and Next.js owns
# /settings/integrations rather than the bare prefix.
# Access logging to stdout, which the awslogs driver ships to
# CloudWatch. Until this existed there was no request-level view of
# production anywhere: DW-103 had been parked since July on "no live
# traffic yet" with nothing able to confirm or deny it.
#
# The Route53 health check hits /api/health/ready every 30 seconds,
# which is 2,880 entries a day of a request nobody will ever read.
# log_skip drops it. Verified by behaviour rather than by reading the
# docs: two health check requests produced no log line and two real
# requests produced one each.
#
# The filter and the second log_skip are not optional. A URI carries
# credentials here: the connector callbacks arrive as ?code=&state=
# (integrations.ts reads both), password reset arrives as ?token=, and
# invite, share, mute and unsubscribe links put a bearer token in the
# path. Logging the raw URI writes all of them into CloudWatch, where
# anyone with logs:FilterLogEvents can replay them.
#
# The whole query string goes, not a list of parameter names. A
# denylist only covers the parameters somebody remembered, so the next
# token-bearing parameter leaks by default; the path is what carries
# the diagnostic value anyway. A callback still logs as
# /integrations/quickbooks/callback, which is the visibility that
# would have caught the Shopify callback 404.
#
# Referer goes too. Referrer-Policy here is
# strict-origin-when-cross-origin, so a same-origin request from
# /reset-password?token=... sends the full URL, and Caddy logs every
# header the client sent. Confirmed by planting a token in a Referer
# against production and finding it in the log.
#
# [?] rather than \? on purpose: the Caddyfile parser eats one
# backslash, Go's regexp then reads \? as an optional literal
# backslash, that matches at position 0, and the replacement blanks
# the entire URI. Secrets gone, paths gone with them. A character
# class needs no escape.
caddyfile = f"""{domain} {{
    header {{
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }}
    log {{
        output stdout
        format filter {{
            wrap json
            fields {{
                request>uri regexp "[?].*" ""
                request>headers>Referer delete
            }}
        }}
    }}
    @healthcheck path /api/health/ready
    log_skip @healthcheck
    @bearertoken path /invite/* /share/* /mute/* /unsubscribe/* /api/invites/* /api/shares/* /api/mute/* /api/digest/unsubscribe/*
    log_skip @bearertoken
    handle /webhooks/* {{
        reverse_proxy api:3001
    }}
    handle /integrations/* {{
        reverse_proxy api:3001
    }}
    reverse_proxy web:3000
}}
"""
caddy_b64 = base64.b64encode(caddyfile.encode()).decode()

commands = [
    # set -e or a failing step just falls through to the next one.
    # A failed `docker compose pull` used to leave `up -d` restarting
    # the stale local image, health check green, deploy reported
    # success, and production silently kept running old code.
    "set -e",
    f"printf '%s' '{env_b64}' | base64 -d > /opt/tellsight/.env",
    # DISABLE_RATE_LIMIT bypasses all four limiter tiers including auth.
    # It belongs to CI, where parallel Playwright workers would otherwise
    # blow the 60/min public limit, and .env.ci sets it. The deploy never
    # writes it, so it can only arrive by someone appending to this file
    # by hand, which is exactly how an ENCRYPTION_KEY got welded to the
    # end of a line and took production down.
    #
    # This check lives here rather than in config.ts because the E2E
    # stack boots the API in production mode with the flag on, and
    # nothing at the config layer can tell that container from this one.
    # The deploy can.
    "grep -qE '^DISABLE_RATE_LIMIT=true' /opt/tellsight/.env && { echo 'REFUSING: DISABLE_RATE_LIMIT=true in the production .env'; exit 1; } || true",
    f"printf '%s' '{caddy_b64}' | base64 -d > /opt/tellsight/Caddyfile",
    # deploy-history is a newest-first list of deployed sha tags, and it
    # is what makes rollback a stack instead of one deep. The previous
    # single .prev.yml converged with the live file after one rollback,
    # so a second one restored the same build it had just rejected.
    #
    # Seeded from the live override the first time, so an instance that
    # predates this still has somewhere to roll back to. Capped at 10
    # because ECR's lifecycle policy keeps 10 tagged images: recording
    # more would promise a rollback the registry cannot serve.
    "cd /opt/tellsight && ([ -f deploy-history ] || grep -o 'sha-[0-9a-f]*' docker-compose.override.yml | head -1 > deploy-history || true)",
    f"cd /opt/tellsight && printf '%s\\n' 'sha-{short}' | cat - deploy-history 2>/dev/null | awk 'NF && !seen[$0]++' | head -10 > .deploy-history.$$ && mv .deploy-history.$$ deploy-history",
    f"printf '%s' '{override_b64}' | base64 -d > /opt/tellsight/docker-compose.override.yml",
    f"aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin {ecr_host}",
    # No age filter. Pinning to sha tags means superseded images stay
    # tagged and never go dangling, so plain `prune -f` reclaims
    # nothing and the disk grows ~1.4GB per deploy. The 48h window
    # that replaced it still filled a 20GB disk on a day with a dozen
    # deploys, which failed a release on "no space left on device".
    #
    # Keeping old images locally was only ever a rollback convenience,
    # and the rollback does not need it: it runs `docker compose pull`
    # and fetches from ECR, which holds the last 10 tags. So the cost
    # of pruning everything unused is roughly a minute of pull on the
    # rare rollback, and the benefit is that disk use stops being a
    # function of deploy frequency. Running images are never removed.
    "docker image prune -af",
    # A pull that runs out of disk fails deep inside a layer write
    # ("failed to register layer"), which reads like a registry
    # problem. Fail here instead, where the message says what is wrong.
    "avail=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
    " && [ \"${avail:-0}\" -ge 4 ]"
    " || { echo \"DISK_TOO_LOW: ${avail}G free after prune, need 4G\" >&2; df -h / >&2; exit 1; }",
    # --quiet: pull progress goes to stderr and floods SSM's output
    # buffer, which truncated the actual failure message last time.
    "cd /opt/tellsight && docker compose pull --quiet",
    # Schema first, as its own step, from the image about to run.
    # Two reasons this is not left to the container entrypoint:
    # a failed migration now aborts the release instead of leaving new
    # code running against an old schema, and the schema change is
    # separable from the code deploy, so a rollback re-pins the image
    # without touching the database. check-migration-compat.ts is what
    # makes that safe, by refusing a migration the previous release
    # cannot survive.
    # --entrypoint sh: the image entrypoint is the thing being bypassed.
    # --no-deps: Postgres is RDS, there is nothing local to start.
    "cd /opt/tellsight && docker compose run --rm --no-deps --entrypoint sh api"
    " -c 'cd /app/apps/api && npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts'",
    "docker compose up -d --remove-orphans",
    # Prove the container is actually on the image we just pulled.
    # set -e catches a failed pull, but this catches the whole class:
    # any path where the deploy reports success while production keeps
    # running something else.
    # Compare against the pinned sha tag, not :latest. compose pulls
    # only what it references, so :latest on the box is now whatever
    # the previous deploy left there and would never match.
    # Both services, not just the API. The web image is pinned in the
    # override the same way and was never checked, so a web container
    # that failed to come up on the new image passed this step.
    f"for svc in api web; do"
    f" case $svc in api) repo={os.environ['ECR_API_REPO']};; web) repo={os.environ['ECR_WEB_REPO']};; esac;"
    f" running=$(docker inspect --format='{{{{.Image}}}}' tellsight-$svc-1);"
    f" expected=$(docker image inspect --format='{{{{.Id}}}}' $repo:sha-{short});"
    f" [ \"$running\" = \"$expected\" ]"
    f" || {{ echo \"DEPLOY DID NOT LAND: tellsight-$svc-1 is not on sha-{short}\" >&2; exit 1; }};"
    f" done",
    # caddy's own image/config never change between deploys, so
    # `up -d` won't recreate it just because the bind-mounted
    # Caddyfile's contents changed on disk -- reload explicitly.
    "docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile",
]

send = subprocess.run([
    "aws", "ssm", "send-command",
    "--instance-ids", os.environ['EC2_INSTANCE_ID'],
    "--document-name", "AWS-RunShellScript",
    "--parameters", json.dumps({"commands": commands}),
    "--output", "json",
], capture_output=True, text=True)

if send.returncode != 0:
    print(send.stderr, file=sys.stderr)
    sys.exit(1)

cmd_id = json.loads(send.stdout)["Command"]["CommandId"]
instance_id = os.environ['EC2_INSTANCE_ID']
print(f"SSM command ID: {cmd_id}")

for _ in range(36):
    time.sleep(5)
    poll = subprocess.run([
        "aws", "ssm", "get-command-invocation",
        "--command-id", cmd_id,
        "--instance-id", instance_id,
        "--output", "json",
    ], capture_output=True, text=True)
    if poll.returncode != 0:
        continue
    inv = json.loads(poll.stdout)
    status = inv.get("Status", "")
    print(f"Status: {status}")
    if status == "Success":
        print(inv.get("StandardOutputContent", ""))
        sys.exit(0)
    if status in ("Failed", "TimedOut", "Cancelled"):
        print(inv.get("StandardErrorContent", ""), file=sys.stderr)
        sys.exit(1)

print("Timed out waiting for SSM command to complete", file=sys.stderr)
sys.exit(1)
