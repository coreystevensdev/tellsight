#!/usr/bin/env bash
set -euo pipefail
host=$(echo "$PROD_URL" | sed -E 's#^https?://##; s#/.*##')

hsts=$(curl --connect-timeout 5 --max-time 15 -sSI "https://$host/" | tr -d '\r' | grep -i '^strict-transport-security:' || true)
if [ -z "$hsts" ]; then
  echo "FAIL: no Strict-Transport-Security header on https://$host/"
  exit 1
fi
echo "$hsts"

# A max-age of 0 is a valid header that switches HSTS off, so the
# header being present is not the same as HSTS being on.
age=$(echo "$hsts" | grep -oE 'max-age=[0-9]+' | cut -d= -f2)
if [ "${age:-0}" -lt 15552000 ]; then
  echo "FAIL: max-age=${age:-0} is under 180 days"
  exit 1
fi

code=$(curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code}' "http://$host/")
case "$code" in
  30[1278]) echo "plain HTTP redirects ($code)" ;;
  *) echo "FAIL: http://$host/ answered $code, expected a redirect"; exit 1 ;;
esac

# The connector callbacks are the one browser-facing path that has to
# reach Express directly, and Caddy is the only thing routing them
# there. That rule was pinned to quickbooks until 2026-09-15, so
# Shopify and Square each shipped with a callback that 404'd in
# production while every test passed: the suites all reach Express
# directly or through Next.js in a compose network, and none of them
# cross the proxy.
#
# 501 is the healthy answer. The gate returns it when a connector has
# no credentials, which proves the request arrived. 404 means Caddy
# handed it to Next.js, which has no route for it.
for provider in quickbooks shopify square; do
  path="/integrations/$provider/callback"
  code=$(curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code}' "https://$host$path")
  case "$code" in
    404) echo "FAIL: $path answered 404, Caddy is not routing it to the API"; exit 1 ;;
    # Fail closed. An unreachable host or a curl that never ran leaves
    # this empty or 000, and a bare *) would call that a pass, which is
    # the same shape of hole this check exists to close.
    ''|000) echo "FAIL: $path produced no status, the request did not complete"; exit 1 ;;
    *) echo "$path reaches the API ($code)" ;;
  esac
done
