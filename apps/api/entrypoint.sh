#!/bin/sh
set -e

cd /app/apps/api

# The production image installs with --prod, so it has no tsx and no src/, and it
# does reach the migrate branch below: docker-compose.ci.yml sets
# MIGRATE_ON_START=true on it because CI has no deploy step to migrate for it.
# NODE_ENV rather than a test for dist/ because the compose override bind-mounts
# apps/api, so a stale host dist/ would quietly migrate dev from old code.
if [ "${NODE_ENV}" = "production" ]; then
  migrate="node dist/db/migrate.js"
  seed="node dist/db/seed.js"
else
  migrate="npx tsx src/db/migrate.ts"
  seed="npx tsx src/db/seed.ts"
fi

# Migrations run here by default so a plain `docker compose up` on an empty
# volume gives you a working stack. Only the production deploy sets
# MIGRATE_ON_START=false, because it runs the same two scripts as an explicit
# step before it swaps any container: a migration that fails should abort the
# release, not leave new code running against an old schema.
#
# Both scripts are idempotent, so the two paths do not conflict.
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
