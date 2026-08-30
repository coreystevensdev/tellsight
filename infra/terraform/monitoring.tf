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
