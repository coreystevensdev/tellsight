#!/usr/bin/env bash
# Prints the test count for every suite, and the totals the README badge claims.
# CI asserts the README against this; run it by hand after adding tests.
#
# Uses `vitest list`, which collects without executing, so this needs no database
# and no browser. Each collection still boots vitest and imports the whole tree,
# which is slow enough that they run concurrently rather than one after another.
# The integration config imports config.ts, which validates the entire env at
# module load, so .env.ci is sourced when present.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.ci ]; then set -a; . ./.env.ci; set +a; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

list() { (cd "$1" && npx vitest list ${3:+-c "$3"} 2>/dev/null | grep -c ' > ') > "$tmp/$2"; }

list apps/api        api &
list apps/web        web &
list packages/shared shared &
list apps/api        integration  vitest.integration.config.ts &
list apps/api        evalscripts  ../../scripts/vitest.config.ts &
(npx playwright test --list 2>/dev/null | grep -oE '^Total: [0-9]+' | grep -oE '[0-9]+') > "$tmp/e2e" &
wait

read -r api < "$tmp/api"
read -r web < "$tmp/web"
read -r shared < "$tmp/shared"
read -r integration < "$tmp/integration"
read -r evalscripts < "$tmp/evalscripts"
read -r e2e < "$tmp/e2e"

# A collection that fails prints nothing, grep -c answers 0, and the suite simply
# disappears from the total. That is how a broken web collection once cut the
# badge by a thousand tests and still produced a number the README could be set
# to. Every suite here has tests, so a zero is a failure, not a count.
for suite in api web shared integration evalscripts e2e; do
  if [ "${!suite}" -eq 0 ]; then
    echo "count-tests: $suite collected 0 tests, which means its collection failed." >&2
    echo "Re-run without the 2>/dev/null in list() to see the error." >&2
    exit 1
  fi
done

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
