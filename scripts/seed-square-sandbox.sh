#!/usr/bin/env bash
set -euo pipefail

# Creates completed orders (and one refund) on a Square sandbox seller, so the
# connector has something to sync. A fresh sandbox account has zero sales, and a
# sync over an empty seller succeeds while writing nothing, which looks exactly
# like a broken sync.
#
# Needs the sandbox ACCESS TOKEN, not the OAuth application secret. Developer
# Dashboard > your application > Sandbox > the test account > access token.
# The connector's own token cannot do this: it asks for read-only scopes.
#
# Usage: bash scripts/seed-square-sandbox.sh [order_count]

HOST="https://connect.squareupsandbox.com"
VERSION="2026-08-19"
COUNT="${1:-6}"

read -r -s -p "Square sandbox access token (EAAA...): " TOKEN
echo
[ -n "$TOKEN" ] || { echo "Token is required."; exit 1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$HOST$path" \
      -H "Authorization: Bearer $TOKEN" -H "Square-Version: $VERSION" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$HOST$path" \
      -H "Authorization: Bearer $TOKEN" -H "Square-Version: $VERSION"
  fi
}

LOCATION=$(api GET /v2/locations | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'errors' in d:
    print('ERR:'+d['errors'][0].get('detail','unknown'), file=sys.stderr); sys.exit(1)
ls=[l for l in d.get('locations',[]) if l.get('status')!='INACTIVE']
if not ls:
    print('ERR:no active locations', file=sys.stderr); sys.exit(1)
print(ls[0]['id'])
")
echo "Using location $LOCATION"

ITEMS=("Flat white:450" "Croissant:395" "Cold brew:525" "Avocado toast:1150" "Blueberry muffin:340" "Espresso:325")
LAST_PAYMENT=""

for i in $(seq 1 "$COUNT"); do
  IFS=: read -r NAME PRICE <<< "${ITEMS[$(( (i - 1) % ${#ITEMS[@]} ))]}"
  QTY=$(( (i % 3) + 1 ))
  TOTAL=$(( PRICE * QTY ))
  KEY="seed-$(date +%s)-$i-$RANDOM"

  ORDER_ID=$(api POST /v2/orders "{
    \"idempotency_key\": \"order-$KEY\",
    \"order\": {
      \"location_id\": \"$LOCATION\",
      \"line_items\": [{
        \"name\": \"$NAME\",
        \"quantity\": \"$QTY\",
        \"base_price_money\": { \"amount\": $PRICE, \"currency\": \"USD\" }
      }]
    }
  }" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'errors' in d:
    print('ERR:'+d['errors'][0].get('detail','unknown'), file=sys.stderr); sys.exit(1)
print(d['order']['id'])
")

  PAYMENT_ID=$(api POST /v2/payments "{
    \"idempotency_key\": \"pay-$KEY\",
    \"source_id\": \"cnon:card-nonce-ok\",
    \"amount_money\": { \"amount\": $TOTAL, \"currency\": \"USD\" },
    \"location_id\": \"$LOCATION\",
    \"order_id\": \"$ORDER_ID\"
  }" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'errors' in d:
    print('ERR:'+d['errors'][0].get('detail','unknown'), file=sys.stderr); sys.exit(1)
print(d['payment']['id'])
")

  printf '  order %d  %-16s x%d  $%.2f  %s\n' "$i" "$NAME" "$QTY" "$(echo "$TOTAL/100" | bc -l)" "$ORDER_ID"
  LAST_PAYMENT="$PAYMENT_ID"
done

# One refund, so the Expenses branch of the normalizer is exercised too. Without
# it every synced row is Income and half the mapping goes untested against real
# data.
if [ -n "$LAST_PAYMENT" ]; then
  api POST /v2/refunds "{
    \"idempotency_key\": \"refund-$(date +%s)-$RANDOM\",
    \"payment_id\": \"$LAST_PAYMENT\",
    \"amount_money\": { \"amount\": 200, \"currency\": \"USD\" },
    \"reason\": \"Seeded test refund\"
  }" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'errors' in d:
    print('  refund skipped: '+d['errors'][0].get('detail','unknown'))
else:
    print('  refund   \$2.00 against the last payment')
"
fi

echo
echo "Done. Now connect at http://localhost:3000/settings/integrations"
