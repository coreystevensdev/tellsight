variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "app_name" {
  description = "Application name used in resource naming"
  type        = string
  default     = "tellsight"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "AZs to spread subnets across"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "api_cpu" {
  description = "Fargate vCPU units for the API task (1024 = 1 vCPU)"
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Memory in MiB for the API task"
  type        = number
  default     = 512
}

variable "web_cpu" {
  description = "Fargate vCPU units for the web task"
  type        = number
  default     = 256
}

variable "web_memory" {
  description = "Memory in MiB for the web task"
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Number of API task replicas"
  type        = number
  default     = 1
}

variable "web_desired_count" {
  description = "Number of web task replicas"
  type        = number
  default     = 1
}

variable "rds_instance_class" {
  description = "RDS instance type"
  type        = string
  default     = "db.t3.micro"
}

variable "rds_db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "analytics"
}

variable "rds_username" {
  description = "PostgreSQL admin username"
  type        = string
  default     = "app_admin"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "domain_name" {
  description = "Custom domain (e.g. tellsight.example.com). Leave empty to use the ALB DNS name."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for HTTPS. Required when domain_name is set."
  type        = string
  default     = ""
}
