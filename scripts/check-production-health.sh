#!/usr/bin/env bash
echo "Polling $PROD_URL/api/health/ready..."
started=$SECONDS
for i in $(seq 1 12); do
  body=$(curl --connect-timeout 3 --max-time 5 -fsS "$PROD_URL/api/health/ready" 2>/dev/null || true)
  if echo "$body" | grep -q '"status":"ok"'; then
    echo "Healthy after $((SECONDS - started))s"
    exit 0
  fi
  [ "$i" -eq 12 ] || sleep 10
done
echo "Production did not become healthy within 3 minutes"
exit 1
