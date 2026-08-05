locals {
  name = var.app_name
}

# Use the default VPC -- avoids NAT Gateway and simplifies routing.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  # "al2023-ami-*-x86_64" also matches the minimal variant
  # (al2023-ami-minimal-*), which excludes the SSM agent and other AWS
  # conveniences the standard AMI bundles by default -- caused SSM to never
  # register on the instance launched from it (25+ minutes, zero
  # registration; describe-images confirmed the "minimal" build got
  # selected). Requiring a version number right after "ami-" excludes
  # "minimal-" without needing negative matching.
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

data "aws_caller_identity" "current" {}
