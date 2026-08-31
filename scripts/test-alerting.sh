#!/usr/bin/env bash
set -euo pipefail

# Prove the paging path still reaches a human, without faking an outage.
#
# The obvious way to test this is `set-alarm-state` on the real alarm, and that
# is what was done on 2026-08-30. It works, but it writes a fake incident into
# the production alarm's history, and CloudWatch cannot tell the two apart
# afterwards: a forced transition emits the same notification a real one does.
# Two of the three ALARM episodes that day were drills, which is exactly the
# ambiguity you do not want when reading alarm history during an incident.
#
# So this fires a throwaway alarm on the same SNS topic instead. That still
# exercises the part that actually breaks (topic, subscription, confirmation
# state, inbox) and leaves the production alarm untouched. What it does not
# cover is the production alarm's own action binding, which is static config and
# is printed below so you can eyeball it.
#
# Usage: bash scripts/test-alerting.sh

TOPIC_NAME="tellsight-alerts"
PROD_ALARM="tellsight-endpoint-down"
TEST_ALARM="tellsight-alerting-selftest"

TOPIC_ARN=$(aws sns list-topics \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text)

if [ -z "$TOPIC_ARN" ] || [ "$TOPIC_ARN" = "None" ]; then
  echo "No SNS topic named ${TOPIC_NAME} in this account/region." >&2
  exit 1
fi

CONFIRMED=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
  --query "length(Subscriptions[?SubscriptionArn!='PendingConfirmation'])" --output text)

echo "Topic:                 ${TOPIC_ARN}"
echo "Confirmed subscribers: ${CONFIRMED}"

if [ "$CONFIRMED" = "0" ]; then
  echo
  echo "Nothing is subscribed, or the subscription was never confirmed." >&2
  echo "A firing alarm would publish successfully and reach nobody." >&2
  exit 1
fi

echo
echo "Production alarm, for comparison (not touched by this script):"
aws cloudwatch describe-alarms --alarm-names "$PROD_ALARM" \
  --query 'MetricAlarms[0].{state:StateValue,onAlarm:AlarmActions,onOk:OKActions}' --output json

cleanup() {
  aws cloudwatch delete-alarms --alarm-names "$TEST_ALARM" 2>/dev/null || true
  echo "Removed ${TEST_ALARM}."
}
trap cleanup EXIT

echo
echo "Creating ${TEST_ALARM}..."
# Points at a metric that is never published, so it can only ever change state
# because this script told it to. Deleting it while in ALARM sends no recovery
# notification, so a drill costs one email rather than two.
aws cloudwatch put-metric-alarm \
  --alarm-name "$TEST_ALARM" \
  --alarm-description "Throwaway alarm for testing SNS delivery. Safe to delete." \
  --namespace "Tellsight/SelfTest" \
  --metric-name "NeverPublished" \
  --statistic Minimum \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

echo "Firing it..."
aws cloudwatch set-alarm-state \
  --alarm-name "$TEST_ALARM" \
  --state-value ALARM \
  --state-reason "Drill from scripts/test-alerting.sh. Production was never unhealthy."

sleep 10

STATE=$(aws cloudwatch describe-alarms --alarm-names "$TEST_ALARM" \
  --query 'MetricAlarms[0].StateValue' --output text)
echo "Test alarm state: ${STATE}"

if [ "$STATE" != "ALARM" ]; then
  echo "Expected ALARM. The notification may not have been published." >&2
  exit 1
fi

echo
echo "Published. SNS delivery metrics lag a few minutes, so check the inbox:"
echo "  subject names ${TEST_ALARM}, not ${PROD_ALARM}"
echo
echo "Production alarm history stays clean:"
aws cloudwatch describe-alarm-history --alarm-name "$PROD_ALARM" \
  --history-item-type StateUpdate --max-records 3 \
  --query 'AlarmHistoryItems[].{when:Timestamp,what:HistorySummary}' --output table
