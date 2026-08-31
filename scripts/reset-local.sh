#!/usr/bin/env bash
set -euo pipefail

# Wipe the local stack back to a first-clone state.
#
# Drops the Postgres and Redis volumes, brings the stack back, then migrates and
# seeds. Use it when local data has drifted somewhere you cannot reason about: a
# half-applied migration, a seed that errored partway, an org stuck in a demo
# state you cannot reproduce.
#
# Migrating explicitly is not redundant. Only the production image has an
# ENTRYPOINT that migrates on boot; the development stage in Dockerfile.api sets
# CMD alone, so a dev container starts against whatever schema happens to be
# there. That is why a fresh `docker compose up` on an empty volume gives you an
# API that answers /health/ready with database:ok and then 500s on every query.
# migrate.ts is idempotent, so running it here is safe against a prod image too.
#
# Usage:
#   bash scripts/reset-local.sh          # confirm, wipe, rebuild, migrate, seed
#   bash scripts/reset-local.sh --yes    # skip the prompt
#   bash scripts/reset-local.sh --down   # tear down and stop, do not bring back up
#   bash scripts/reset-local.sh --no-seed

MAX_WAIT=120

ASSUME_YES=false
DOWN_ONLY=false
RUN_SEED=true
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    --down) DOWN_ONLY=true ;;
    --no-seed) RUN_SEED=false ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running." >&2
  exit 1
fi

# Name the volumes rather than saying "your data", so the prompt is answerable
# by someone who does not already know what compose created.
VOLUMES=$(docker compose config --volumes | tr '\n' ' ')

if [ "$ASSUME_YES" = false ]; then
  echo "This deletes the local database and every uploaded dataset in it."
  echo "Volumes to be removed: ${VOLUMES}"
  echo "Production is untouched; this only affects this machine."
  read -r -p "Type 'reset' to continue: " reply
  if [ "$reply" != "reset" ]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Stopping containers and removing volumes..."
docker compose down -v --remove-orphans

if [ "$DOWN_ONLY" = true ]; then
  echo "Stack is down and volumes are gone. 'docker compose up' to rebuild."
  exit 0
fi

echo "Starting db, redis, api..."
docker compose up -d db redis
docker compose up -d api

echo "Waiting for the API to accept connections (up to ${MAX_WAIT}s)..."
elapsed=0
until curl -sf -m 3 http://localhost:3001/health/live >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    echo "API did not start within ${MAX_WAIT}s." >&2
    docker compose logs --tail 40 api >&2
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
echo "API up in ${elapsed}s."

echo "Running migrations..."
docker compose exec -T -w /app/apps/api api npx tsx src/db/migrate.ts

if [ "$RUN_SEED" = true ]; then
  echo "Seeding..."
  docker compose exec -T -w /app/apps/api api npx tsx src/db/seed.ts
fi

# /health/ready runs SELECT 1, which passes against a database with no tables at
# all, so it cannot confirm a reset worked. Check for the table itself.
#
# to_regclass rather than `select from users`: under RLS an empty result is a
# legitimate answer for a role with no org context, so a row count cannot tell
# "table missing" apart from "nothing visible to you". Credentials come from the
# container's own env so this keeps working if compose changes them.
echo "Verifying the schema is actually there..."
psql_q() {
  docker compose exec -T db sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "'"$1"'"' 2>/dev/null | tr -d '[:space:]'
}

if [ "$(psql_q "select to_regclass('public.users') is not null")" != "t" ]; then
  echo "Migrations reported success but public.users does not exist." >&2
  exit 1
fi

TABLES=$(psql_q "select count(*) from information_schema.tables where table_schema = 'public'")

echo
echo "Reset complete. ${TABLES} tables in public."
curl -s http://localhost:3001/health/ready
echo
echo
echo "'docker compose up -d web' for the frontend on :3000."
