#!/usr/bin/env bash
# Prints the test count for every suite, and the totals the README badge claims.
# CI asserts the README against the same numbers; run this by hand after adding tests.
#
# This runs the suites rather than collecting them. `vitest list` was cheaper and
# needed no database, but it stopped being a usable count under vitest 5: an
# it.each lists once as its unexpanded "%s" template rather than once per case,
# so the collected total read 4,015 while 4,502 tests still ran. The JSON
# reporter's numTotalTests is what actually executed.
#
# The integration suite therefore needs a live database:
#
#   docker compose up -d db
#   DATABASE_URL=postgresql://app_user:app@localhost:5433/analytics \
#   DATABASE_ADMIN_URL=postgresql://app_admin:app@localhost:5433/analytics \
#     bash scripts/count-tests.sh
#
# .env.ci is sourced for that suite only. It must not reach the unit suites:
# its CLAUDE_API_KEY sends them down the live-client path, the network guard
# blocks the call, and six tests fail that pass with a clean environment.
#
# Playwright is unaffected by the vitest change and `--list` still expands
# correctly there, so E2E stays a collection and needs no browsers or stack.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Each run writes its own report, then count-from-reports.mjs reads the counts.
# Serial rather than concurrent: these execute now, and five suites competing for
# the same cores made the api suite flake on timeouts.
run() {
  local dir=$1 name=$2 config=${3:-} withenv=${4:-}
  (
    cd "$dir"
    if [ -n "$withenv" ] && [ -f ../../.env.ci ]; then
      # .env.ci points at the compose-internal db:5432, which does not resolve
      # from the host, so anything the caller set has to survive the sourcing.
      local caller_db=${DATABASE_URL:-} caller_admin=${DATABASE_ADMIN_URL:-}
      set -a; . ../../.env.ci; set +a
      [ -n "$caller_db" ] && export DATABASE_URL="$caller_db"
      [ -n "$caller_admin" ] && export DATABASE_ADMIN_URL="$caller_admin"
    fi
    npx vitest run ${config:+-c "$config"} \
      --reporter=json --outputFile.json="$tmp/$name.json" >/dev/null 2>&1
  ) || {
    echo "count-tests: the $name suite failed to run, so it cannot be counted." >&2
    echo "Re-run it directly to see the error. Integration needs a database." >&2
    exit 1
  }
}

run apps/api        api
run apps/web        web
run packages/shared shared
run apps/api        integration  vitest.integration.config.ts        with-env
run apps/api        evalscripts  ../../scripts/vitest.config.ts
e2e=$(npx playwright test --list 2>/dev/null | grep -oE '^Total: [0-9]+' | grep -oE '[0-9]+')

count() { node scripts/count-from-reports.mjs "$tmp/$1.json"; }
api=$(count api)
web=$(count web)
shared=$(count shared)
integration=$(count integration)
evalscripts=$(count evalscripts)

# A collection that fails prints nothing, grep -c answers 0, and the suite simply
# disappears from the total. That is how a broken web collection once cut the
# badge by a thousand tests and still produced a number the README could be set
# to. count-from-reports.mjs rejects a zero for the vitest suites; playwright is
# still counted by grep, so it needs the check here.
if [ -z "${e2e:-}" ] || [ "$e2e" -eq 0 ]; then
  echo "count-tests: playwright collected 0 tests, which means its collection failed." >&2
  exit 1
fi

vitest=$((api + web + shared + integration + evalscripts))
total=$((vitest + e2e))

# The README writes these with thousands separators. python3 rather than
# printf "%'d", which silently emits no separator outside a grouping locale, or
# a sed loop, which needs GNU sed and so cannot be checked on a mac.
fmt() { python3 -c "import sys; print(f'{int(sys.argv[1]):,}')" "$1"; }

cat <<EOF
api            $api
web            $web
shared         $shared
integration    $integration
eval-scripts   $evalscripts
playwright     $e2e
vitest         $vitest
total          $total
vitest_fmt     $(fmt $vitest)
total_fmt      $(fmt $total)
EOF
