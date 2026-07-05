output "alb_dns_name" {
  description = "Public DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "ecr_api_url" {
  description = "ECR repository URL for the API image"
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_web_url" {
  description = "ECR repository URL for the web image"
  value       = aws_ecr_repository.web.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name (used in GitHub Actions deploy step)"
  value       = aws_ecs_cluster.main.name
}

output "ecs_api_service_name" {
  description = "ECS service name for the API (used in GitHub Actions deploy step)"
  value       = aws_ecs_service.api.name
}

output "ecs_web_service_name" {
  description = "ECS service name for the web app (used in GitHub Actions deploy step)"
  value       = aws_ecs_service.web.name
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host only)"
  value       = aws_db_instance.main.address
  sensitive   = false
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "app_secret_arn" {
  description = "Secrets Manager ARN for application secrets (set values manually after apply)"
  value       = aws_secretsmanager_secret.app.arn
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (add to repo secret AWS_ROLE_ARN)"
  value       = aws_iam_role.github_actions.arn
}
