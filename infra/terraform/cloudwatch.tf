resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name_prefix}/api"
  retention_in_days = 30

  tags = { Name = "${local.name_prefix}-api-logs" }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name_prefix}/web"
  retention_in_days = 30

  tags = { Name = "${local.name_prefix}-web-logs" }
}
