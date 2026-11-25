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

  // Calls the shipped gate instead of restating it. The hand-written join that
  // used to live here drifted: it read datasets.created_at and only the active
  // dataset, while the gate moved to max(data_refreshed_at) across the non-seed
  // datasets of an org (DW-281, then PRs 432 and 435). On 2026-11-25 it
  // answered 0 for an org that had been sent a digest three days earlier, which
  // is a failure mode a census has no business having.
  //
  // Neither a single quote nor a hash is safe in this heredoc. It sits inside a
  // command substitution, and that parser still reads both while hunting the
  // closing paren, so either one swallows it and bash reports EOF at line 30.
  const queries = await import('/app/apps/api/dist/db/queries/index.js');
  const eligible = await queries.digestEligibilityQueries.findEligibleOrgs();
  const paused = await queries.digestEligibilityQueries.countOrgsPausedForStaleData();
  console.log('ELIGIBILITY ' + JSON.stringify({
    eligible_orgs: eligible.length,
    eligible_org_ids: eligible.map((o) => o.id),
    paused_for_stale_data: paused,
  }));

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
# The script has to land in the api workspace, not /app and not /tmp: node
# resolves bare imports relative to the file, and pnpm leaves `postgres` in
# apps/api/node_modules rather than hoisting it to the workdir root. At /app it
# dies with ERR_MODULE_NOT_FOUND before reaching the database.
#
# The node exit code is captured rather than left to abort the script, so both
# rm steps still run when a query throws. Without it, set -e skips them and
# leaves the temp file inside the running container.
CMDS=$(jq -nc --arg b64 "$SCRIPT_B64" --arg since "$SINCE" '[
  "set -e",
  "cd /opt/tellsight",
  "printf %s \($b64) | base64 -d > /tmp/digest-check.mjs",
  "docker compose cp /tmp/digest-check.mjs api:/app/apps/api/digest-check.mjs",
  "docker compose exec -T api node /app/apps/api/digest-check.mjs \($since) || rc=$?",
  "docker compose exec -T api rm -f /app/apps/api/digest-check.mjs",
  "rm -f /tmp/digest-check.mjs",
  "exit ${rc:-0}"
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
