#!/bin/sh
set -e

cd /app/apps/api

# Migrations run here by default so a plain `docker compose up` on an empty
# volume gives you a working stack. Only the production deploy sets
# MIGRATE_ON_START=false, because it runs the same two scripts as an explicit
# step before it swaps any container: a migration that fails should abort the
# release, not leave new code running against an old schema.
#
# Both scripts are idempotent, so the two paths do not conflict.
# The production image installs with --prod, so it has no tsx and no src/. It
# still reaches this branch: docker-compose.ci.yml sets MIGRATE_ON_START=true on
# the production image because CI has no deploy step to migrate for it. So the
# runner follows NODE_ENV rather than being hardcoded. Keying off a file check
# instead would misfire in dev, where the compose override bind-mounts apps/api
# and a stale host dist/ would silently migrate from old code.
if [ "${NODE_ENV}" = "production" ]; then
  migrate="node dist/db/migrate.js"
  seed="node dist/db/seed.js"
else
  migrate="npx tsx src/db/migrate.ts"
  seed="npx tsx src/db/seed.ts"
fi

if [ "${MIGRATE_ON_START:-true}" = "false" ]; then
  echo "MIGRATE_ON_START=false, skipping migrate and seed (the deploy runs them)"
else
  echo "Running database migrations..."
  $migrate

  echo "Running seed..."
  $seed
fi

cd /app

echo "Starting API server..."
exec "$@"
