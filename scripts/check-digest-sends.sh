#!/usr/bin/env bash
set -euo pipefail

# Reads digest_history out of production to answer "has the weekly digest
# actually sent to anyone yet". Epic 11 parked three design decisions behind
# that question and no admin surface exposes it.
#
# RDS is not publicly reachable (publicly_accessible = false, and its security
# group only admits the EC2 instance), so this runs inside the api container
# over SSM rather than connecting directly. Read-only: SELECT only.
#
# Usage: bash scripts/check-digest-sends.sh [since-date]   # default 2026-08-09

SINCE="${1:-2026-08-09}"
REGION="${AWS_REGION:-us-east-1}"

INSTANCE_ID="${EC2_INSTANCE_ID:-$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:Name,Values=tellsight-server" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)}"

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "Could not find a running tellsight-server instance. Set EC2_INSTANCE_ID." >&2
  exit 1
fi
echo "Querying via $INSTANCE_ID..."

# Sent as base64 so the SQL's quotes never have to survive two layers of shell
# plus JSON escaping.
NODE_SCRIPT=$(cat <<'JS'
import postgres from 'postgres';

const since = process.argv[2];
// ADMIN url, not DATABASE_URL. This is a platform-wide census and the
// RLS-scoped app_user returns zero rows for every org-scoped table when no
// org context is set, which silently reads as "nothing here".
const sql = postgres(process.env.DATABASE_ADMIN_URL, { max: 1 });

try {
  const [totals] = await sql`
    SELECT count(*)::int AS sends,
           count(DISTINCT org_id)::int AS orgs,
           min(week_start)::date AS first_week,
           max(week_start)::date AS last_week
    FROM digest_history
  `;
  console.log('TOTALS ' + JSON.stringify(totals));

  // Counting each predicate separately answers the wrong question: five counts
  // can all be non-zero while no single org satisfies all five. This is the
  // same join findEligibleOrgs runs. A missing digest_preferences row means
  // eligible, not opted out, which is why the LEFT JOIN allows a NULL cadence.
  const [eligibility] = await sql`
    SELECT count(*)::int AS eligible_orgs
    FROM orgs o
    JOIN subscriptions s ON s.org_id = o.id
    JOIN datasets d ON d.id = o.active_dataset_id
    WHERE s.status = 'active' AND s.plan = 'pro'
      AND o.active_dataset_id IS NOT NULL
      AND d.created_at >= now() - interval '30 days'
      AND EXISTS (
        SELECT 1 FROM user_orgs uo
        LEFT JOIN digest_preferences dp ON dp.user_id = uo.user_id
        WHERE uo.org_id = o.id AND (dp.cadence IS NULL OR dp.cadence <> 'off'))
  `;
  console.log('ELIGIBILITY ' + JSON.stringify(eligibility));

  const recent = await sql`
    SELECT week_start::date AS week,
           org_id,
           length(subject_line) AS subject_len,
           subject_line,
           valence,
           jsonb_array_length(milestones) AS milestones
    FROM digest_history
    WHERE week_start >= ${since}
    ORDER BY week_start DESC, org_id
    LIMIT 50
  `;
  console.log('RECENT ' + JSON.stringify(recent));
} finally {
  await sql.end();
}
JS
)

SCRIPT_B64=$(printf '%s' "$NODE_SCRIPT" | base64)

# set -e first, otherwise a failing step in the middle still leaves SSM
# reporting Success because the last command exited 0.
# The script has to land in /app, not /tmp: node resolves bare imports relative
# to the file, and node_modules only exists at the container's workdir.
CMDS=$(jq -nc --arg b64 "$SCRIPT_B64" --arg since "$SINCE" '[
  "set -e",
  "cd /opt/tellsight",
  "printf %s \($b64) | base64 -d > /tmp/digest-check.mjs",
  "docker compose cp /tmp/digest-check.mjs api:/app/digest-check.mjs",
  "docker compose exec -T api node /app/digest-check.mjs \($since)",
  "docker compose exec -T api rm -f /app/digest-check.mjs",
  "rm -f /tmp/digest-check.mjs"
]')

CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "commands=$CMDS" \
  --query 'Command.CommandId' --output text)

aws ssm wait command-executed --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'Status' --output text)

aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

if [ "$STATUS" != "Success" ]; then
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text >&2
  echo "SSM status: $STATUS" >&2
  exit 1
fi
