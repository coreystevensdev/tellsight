output "instance_public_ip" {
  description = "Static public IP -- create an A record for '${var.domain}' pointing here, then run certbot"
  value       = aws_eip.main.public_ip
}

output "instance_id" {
  description = "EC2 instance ID -- set as EC2_INSTANCE_ID GitHub Actions secret"
  value       = aws_instance.main.id
}

output "ecr_api_url" {
  description = "ECR repository URL for the API image -- set as ECR_API_REPO GitHub Actions secret"
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_web_url" {
  description = "ECR repository URL for the web image -- set as ECR_WEB_REPO GitHub Actions secret"
  value       = aws_ecr_repository.web.repository_url
}

output "rds_endpoint" {
  description = "RDS PostgreSQL host -- used to build DATABASE_URL GitHub Actions secret"
  value       = aws_db_instance.main.address
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC -- set as AWS_ROLE_ARN GitHub Actions secret"
  value       = aws_iam_role.github_actions.arn
}
