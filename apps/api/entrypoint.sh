#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/apps/api
npx tsx src/db/migrate.ts

echo "Running seed..."
npx tsx src/db/seed.ts
cd /app

echo "Starting API server..."
exec "$@"
