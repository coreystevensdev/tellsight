resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name_prefix}/app"
  description             = "Application secrets for Tellsight"
  recovery_window_in_days = 7

  tags = { Name = "${local.name_prefix}-app-secret" }
}

# Populate this manually after `terraform apply` using:
#   aws secretsmanager put-secret-value \
#     --secret-id <secret_arn> \
#     --secret-string '{"CLAUDE_API_KEY":"...","STRIPE_SECRET_KEY":"...",...}'
#
# Keys the tasks expect in the JSON payload:
#   CLAUDE_API_KEY, CLAUDE_MODEL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
#   STRIPE_PRICE_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET,
#   QUICKBOOKS_CLIENT_ID (optional), QUICKBOOKS_CLIENT_SECRET (optional)
resource "aws_secretsmanager_secret_version" "app_placeholder" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    CLAUDE_API_KEY          = "REPLACE_ME"
    CLAUDE_MODEL            = "claude-sonnet-4-6"
    STRIPE_SECRET_KEY       = "REPLACE_ME"
    STRIPE_WEBHOOK_SECRET   = "REPLACE_ME"
    STRIPE_PRICE_ID         = "REPLACE_ME"
    GOOGLE_CLIENT_ID        = "REPLACE_ME"
    GOOGLE_CLIENT_SECRET    = "REPLACE_ME"
    JWT_SECRET              = "REPLACE_ME_MIN_32_CHARS"
  })

  lifecycle {
    # Prevent Terraform from overwriting real secrets on subsequent applies.
    ignore_changes = [secret_string]
  }
}
