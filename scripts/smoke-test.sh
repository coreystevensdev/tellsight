#!/usr/bin/env bash
set -euo pipefail

# Docker smoke test, Stage 5 of CI pipeline.
# Proves the "hiring manager test": clone → docker compose up → working app.
#
# Usage:
#   bash scripts/smoke-test.sh              # local, uses default compose (dev override)
#   bash scripts/smoke-test.sh --ci         # CI, production build, explicit compose files
#   bash scripts/smoke-test.sh --ci --load  # also run k6 against the booted stack

MAX_WAIT=90
API_URL="http://localhost:3001/health"

CI_MODE=false
RUN_LOAD=false
for arg in "$@"; do
  case "$arg" in
    --ci) CI_MODE=true ;;
    --load) RUN_LOAD=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# CI mode uses production build targets (skips dev override)
if [[ "$CI_MODE" == true ]]; then
  COMPOSE="docker compose -f docker-compose.yml -f docker-compose.ci.yml"
else
  echo "WARNING: Running locally, this will 'docker compose down --volumes' on exit."
  echo "Press Ctrl+C within 3s to abort, or pass --ci for production build."
  sleep 3
  COMPOSE="docker compose"
fi

cleanup() {
  echo "Tearing down..."
  $COMPOSE down --volumes --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting Docker Compose..."
$COMPOSE up -d --build

echo "Waiting for API health check (max ${MAX_WAIT}s)..."
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "$API_URL" > /dev/null 2>&1; then
    echo "API healthy after ${i}s"
    break
  fi
  if [ "$i" -eq "$MAX_WAIT" ]; then
    echo "FAIL: API not healthy after ${MAX_WAIT}s"
    echo "--- Docker logs ---"
    $COMPOSE logs --tail=50
    exit 1
  fi
  sleep 1
done

# verify HTTP 200 explicitly
HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$API_URL")
if [ "$HTTP_STATUS" != "200" ]; then
  echo "FAIL: Expected HTTP 200 from /health, got ${HTTP_STATUS}"
  exit 1
fi

echo "PASS: Docker smoke test succeeded"

# Load test rides the stack this script already booted rather than paying for a
# second compose up. k6 exits non-zero when a threshold in k6/load-test.js is
# breached, and set -e carries that out of here.
if [[ "$RUN_LOAD" == true ]]; then
  if ! command -v k6 > /dev/null 2>&1; then
    echo "FAIL: --load requested but k6 is not installed"
    exit 1
  fi
  echo "Running k6 load test against the booted stack..."
  K6_BASE_URL="http://localhost:3001" k6 run k6/load-test.js
  echo "PASS: k6 SLO thresholds held"
fi
