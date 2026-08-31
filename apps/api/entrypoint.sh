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
if [ "${MIGRATE_ON_START:-true}" = "false" ]; then
  echo "MIGRATE_ON_START=false, skipping migrate and seed (the deploy runs them)"
else
  echo "Running database migrations..."
  npx tsx src/db/migrate.ts

  echo "Running seed..."
  npx tsx src/db/seed.ts
fi

cd /app

echo "Starting API server..."
exec "$@"
