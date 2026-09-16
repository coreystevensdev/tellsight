#!/usr/bin/env bash
set -euo pipefail

# Fills the Square credentials into .env without them passing through a shell
# history or a chat transcript. The secret is read with -s, so it does not echo.
#
# Usage: bash scripts/set-square-credentials.sh

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] || { echo "No .env at $ENV_FILE"; exit 1; }

echo "Square credentials go in at developer.squareup.com > your application > OAuth."
echo "Use the Sandbox pair, not Production. Nothing you type here is echoed back."
echo

read -r -p "Application ID  (sandbox-sq0idb-...): " APP_ID
read -r -s -p "Application Secret: " APP_SECRET
echo
[ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] || { echo "Both values are required."; exit 1; }

# read -s echoes nothing, so a double paste is invisible until Square answers
# 401 service.not_authorized on the token exchange, which reads like a wrong
# secret rather than a repeated one. Shape-check both before writing.
check() {
  local name="$1" value="$2" prefix="$3" want_len="$4"
  case "$value" in
    "$prefix"*) ;;
    *) echo "$name does not start with $prefix. Wrong field copied?"; exit 1 ;;
  esac
  local n=${#value}
  if [ "$n" -ne "$want_len" ]; then
    local reps=$(printf '%s' "$value" | grep -o "$prefix" | wc -l | tr -d ' ')
    if [ "$reps" -gt 1 ]; then
      echo "$name contains $prefix $reps times ($n chars). It looks pasted more than once."
    else
      echo "$name is $n chars, expected $want_len."
    fi
    exit 1
  fi
}
check "Application ID"     "$APP_ID"     "sandbox-sq0idb-" 37
check "Application Secret" "$APP_SECRET" "sandbox-sq0csb-" 58

# Backup goes outside the repo. Leaving a .env.bak next to .env puts a file
# holding JWT_SECRET and DATABASE_URL one `git add -A` away from a commit.
BACKUP="${TMPDIR:-/tmp}/tellsight-env-$(date +%Y%m%d-%H%M%S).bak"
cp "$ENV_FILE" "$BACKUP"

# Drop any existing Square lines, commented or not, then write a clean block.
# Rewriting beats sed-in-place on four separate lines, which is how a stray
# value once got welded onto the end of the previous key.
grep -vE '^#? *SQUARE_(CLIENT_ID|CLIENT_SECRET|REDIRECT_URI|ENVIRONMENT)=' "$ENV_FILE" > "$ENV_FILE.tmp"

# The file must end in a newline before appending. A .env without one is how
# production went down on 2026-08-31, when a deploy appended to it and welded
# two keys together.
[ -s "$ENV_FILE.tmp" ] && [ "$(tail -c1 "$ENV_FILE.tmp" | wc -l)" -eq 0 ] && echo >> "$ENV_FILE.tmp"

cat >> "$ENV_FILE.tmp" <<INNER
SQUARE_CLIENT_ID=$APP_ID
SQUARE_CLIENT_SECRET=$APP_SECRET
SQUARE_REDIRECT_URI=http://localhost:3001/integrations/square/callback
SQUARE_ENVIRONMENT=sandbox
INNER

mv "$ENV_FILE.tmp" "$ENV_FILE"

echo "Written. Previous file kept at $BACKUP"
echo
echo "Register this exact redirect URL on the same Square OAuth page:"
echo "  http://localhost:3001/integrations/square/callback"
echo
echo "Then recreate the api container so it reads the new file:"
echo "  docker compose up -d api        # not 'restart', which reuses the old env"
