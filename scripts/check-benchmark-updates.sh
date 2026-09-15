#!/usr/bin/env bash
set -euo pipefail

# Answers "is there a newer SOI table than the ones the benchmark card ships".
#
# Two publishers' worth of gotchas are baked in here rather than rediscovered:
# the IRS listing pages lag their own data (the S-corporation statistics page
# said 2017 was newest while Publication 16 carried 2022), so this probes the
# file URLs directly. And the sole-proprietor tables are legacy .xls, which the
# extraction needs soffice to convert before anything can read them.
#
# The employer table is the one that lags: sole proprietors are already on
# TY2023, S-corps on TY2022. Corporation tables for TY2023 were scheduled for
# 2026-09-23, with the calendar itself marked for republication "following the
# restoration of appropriations", so the date may move.
#
# Usage: bash scripts/check-benchmark-updates.sh

BASE="https://www.irs.gov/pub/irs-soi"

probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/$1" || echo "000"; }

echo "Shipping now:"
echo "  sole proprietor   Tables 1 and 2, TY2023   23sp01br.xls + 23sp02is.xls"
echo "  employer (S-corp) Table 6.1,      TY2022   22co61ccr.xlsx"
echo

found=0
for yy in 23 24 25; do
  code=$(probe "${yy}co61ccr.xlsx")
  printf '  20%s employer Table 6.1  %s\n' "$yy" "$code"
  [ "$code" = "200" ] && found=1
done

for yy in 24 25; do
  printf '  20%s sole prop Table 1    %s\n' "$yy" "$(probe "${yy}sp01br.xls")"
  printf '  20%s sole prop Table 2    %s\n' "$yy" "$(probe "${yy}sp02is.xls")"
done

echo
if [ "$found" = "1" ]; then
  echo "A newer employer table is published. Refreshing it means re-extracting"
  echo "receipts, net income, officer compensation, salaries, rents paid,"
  echo "depreciation, interest paid, advertising and repairs, then checking the"
  echo "new receipts against the stored ones before trusting any column mapping."
  echo "Sector labels sit in row 5 and carry embedded newlines, so normalise"
  echo "whitespace before matching them."
else
  echo "Nothing newer. TY2022 remains the latest employer table."
fi
