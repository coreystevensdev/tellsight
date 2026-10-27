# NFR30 puts RTO at 4 hours "from detection" and states outright that detection
# was not automated. This is what closes that gap: nothing else in the stack
# notices an outage, so the interval before a human looked was unbounded.
#
# Deliberately external to the instance. A monitor running on the box cannot
# report that the box is down, and Prometheus is off it anyway (1GB of RAM).

# Pinned to the EIP rather than the hostname because Route53 prices health
# checks by target: AWS endpoints are free for the first 50, non-AWS are
# $0.75/month each. fqdn still supplies the Host header and SNI so Caddy routes
# and the certificate matches.
resource "aws_route53_health_check" "app" {
  type              = "HTTPS"
  ip_address        = aws_eip.main.public_ip
  port              = 443
  fqdn              = var.domain_name
  resource_path     = "/api/health/ready"
  request_interval  = 30
  failure_threshold = 3

  # measure_latency and SNI-disable are billed as "optional features" at
  # $1/month. Not worth it to learn what the smoke test already reports.
  measure_latency = false

  tags = { Name = "${local.name}-health" }
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
  tags = { Name = "${local.name}-alerts" }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Route53 publishes health check metrics to us-east-1 only, which is where this
# stack already lives.
#
# treat_missing_data = "breaching": a health check that stops reporting is not
# reassuring, and defaulting to "missing" would have made this alarm quietly
# useless in exactly the case it exists for.
resource "aws_cloudwatch_metric_alarm" "app_down" {
  alarm_name          = "${local.name}-endpoint-down"
  alarm_description   = "GET https://${var.domain_name}/api/health/ready stopped returning 200. Starts the RTO clock in NFR30."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.app.id }
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 2
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name}-endpoint-down" }
}

# ------------------------------------------------------------------
# Container logs
# ------------------------------------------------------------------

# Container logs lived only in the container that wrote them, under json-file.
# The deploy recreates api and web on every merge, so their logs were destroyed
# several times a week and nothing older than the last deploy existed anywhere.
# That made three deferred items unanswerable rather than merely unanswered:
# DW-216 says to revisit "once Refresh token reuse detected appears in
# production logs at all", which no retained log could ever show, and DW-103's
# "no live traffic yet" was decided before launch with nothing since able to
# report otherwise.
#
# The CloudWatch agent is the usual answer and is not affordable here: 916MB of
# RAM with 259MB free and swap already in use, which is the same budget that
# kept Prometheus off this box. The awslogs driver needs no agent because the
# Docker daemon ships the stream itself.
resource "aws_cloudwatch_log_group" "containers" {
  name              = "/tellsight/containers"
  retention_in_days = 30

  tags = { Name = "${local.name}-container-logs" }
}

# CreateLogGroup is deliberately absent. The group above is the only one the
# driver may write to, so a typo in awslogs-group fails the container rather
# than silently creating a second group nothing queries.
resource "aws_iam_role_policy" "ec2_container_logs" {
  name = "${local.name}-ec2-container-logs"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ShipContainerLogs"
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      Resource = [
        aws_cloudwatch_log_group.containers.arn,
        "${aws_cloudwatch_log_group.containers.arn}:log-stream:*",
      ]
    }]
  })
}

# ------------------------------------------------------------------
# Job failures
# ------------------------------------------------------------------

# There was an alarm for the endpoint being down and none for a job that fails,
# so on 2026-10-25 the weekly digest failed three times for a paying org and
# nobody knew for nine and a half hours. The digest is the retention loop; its
# entire delivery path could fail in silence.
#
# A metric filter rather than publishing from the worker's `failed` listener:
# the listener runs inside the process that is already having a bad time, and
# an SNS call from there fails exactly when it is most needed. CloudWatch reads
# the log after the fact, so it still fires if the container dies.
#
# BullMQ emits `failed` once per attempt. Intermediate failures use a different
# warning message; only an exhausted attempt emits the error matched here. This
# keeps a retry that later succeeds from paging and claiming delivery failed.
resource "aws_cloudwatch_log_metric_filter" "digest_job_failed" {
  name           = "${local.name}-digest-job-failed"
  log_group_name = aws_cloudwatch_log_group.containers.name
  pattern        = "{ $.msg = \"Digest worker job terminal failure\" }"

  metric_transformation {
    name      = "DigestJobFailed"
    namespace = "Tellsight/Jobs"
    value     = "1"
    # Absent means no failures, so the alarm below can treat missing data as
    # healthy rather than reading a quiet week as an outage.
    default_value = 0
  }
}

# notBreaching, unlike the endpoint alarm above. A health check that stops
# reporting is itself bad news; a failure counter that reports nothing is the
# good case, and treating its absence as breaching would page every week the
# digest worked.
resource "aws_cloudwatch_metric_alarm" "digest_job_failed" {
  alarm_name          = "${local.name}-digest-job-failed"
  alarm_description   = "A digest worker job exhausted its retries. The weekly digest is the retention loop and a terminal failure here means a paying org silently received nothing."
  namespace           = aws_cloudwatch_log_metric_filter.digest_job_failed.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.digest_job_failed.metric_transformation[0].name
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name}-digest-job-failed" }
}

# Separate from the digest alarm on purpose. The 2026-10-25 root cause was an
# exhausted Anthropic balance, which breaks every AI surface at once: summaries,
# alerts and NL Q&A as well as the digest. The digest alarm would only have
# fired because the weekly cron happened to run that evening; a browser hitting
# a summary would have failed the same way and said nothing. The billable
# health probe emits the same non-retryable message, so billing/auth outages
# alert during quiet periods too.
#
# Non-retryable specifically, since that is the class nothing recovers from on
# its own: billing, auth, and malformed requests. Transient errors already
# retry and are logged at warn.
resource "aws_cloudwatch_log_metric_filter" "claude_non_retryable" {
  name           = "${local.name}-claude-non-retryable"
  log_group_name = aws_cloudwatch_log_group.containers.name
  pattern        = "{ $.msg = \"Claude API non-retryable error\" || $.msg = \"Claude API stream non-retryable error\" }"

  metric_transformation {
    name          = "ClaudeNonRetryableError"
    namespace     = "Tellsight/AI"
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "claude_non_retryable" {
  alarm_name          = "${local.name}-claude-non-retryable"
  alarm_description   = "The Anthropic API refused a request in a way that will not fix itself: billing, auth, or a malformed request. Every AI surface is affected, not just the digest."
  namespace           = aws_cloudwatch_log_metric_filter.claude_non_retryable.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.claude_non_retryable.metric_transformation[0].name
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  period              = 300
  # The health probe is cached for five minutes and /health runs every thirty
  # seconds, so consecutive failures can land just over five minutes apart.
  # Keep ALARM if either of the last two periods contains one rather than
  # sending a false recovery and paging again at the next probe.
  evaluation_periods  = 2
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name}-claude-non-retryable" }
}
