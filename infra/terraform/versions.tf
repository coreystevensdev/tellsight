terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment after creating the S3 bucket and DynamoDB table:
  # backend "s3" {
  #   bucket         = "tellsight-tfstate"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "tellsight-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "tellsight"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
