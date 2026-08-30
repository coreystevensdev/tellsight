variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name used in resource naming"
  type        = string
  default     = "tellsight"
}

variable "db_password" {
  description = "RDS PostgreSQL master password (min 8 chars)"
  type        = string
  sensitive   = true
}

variable "domain_name" {
  description = "Public hostname Caddy serves, used as the health check's Host header and SNI"
  type        = string
  default     = "tellsight.coreystevens.dev"
}

variable "alert_email" {
  description = "Where health-check alarms are delivered. AWS emails a confirmation link that must be clicked before anything is sent."
  type        = string
}
