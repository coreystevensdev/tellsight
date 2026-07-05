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

variable "domain" {
  description = "Public domain for the app (e.g. tellsight.coreystevens.dev)"
  type        = string
  default     = "tellsight.coreystevens.dev"
}
