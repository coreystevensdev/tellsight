resource "aws_security_group" "rds" {
  name        = "${local.name}-rds-sg"
  description = "Allow PostgreSQL from EC2 only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds-sg" }
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnet"
  subnet_ids = data.aws_subnets.default.ids

  tags = { Name = "${local.name}-db-subnet" }
}

resource "aws_db_instance" "main" {
  identifier = "${local.name}-db"

  engine = "postgres"
  # Matches local dev's postgres:18.2 (docker-compose.yml). Confirmed
  # available in us-east-1 as of 2026-08-05 (18.1-18.4 listed).
  engine_version = "18"
  # Free tier: db.t3.micro 750 hrs/month for the first 12 months.
  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  max_allocated_storage = 100
  storage_encrypted     = true

  db_name  = "analytics"
  username = "app_admin"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # backup_retention_period is Computed, not defaulted, so leaving it unset
  # silently meant AWS's 1-day default on an instance holding real user data.
  # deletion_protection makes `terraform destroy` fail until someone flips it
  # back by hand, which is the point.
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-db-final"

  tags = { Name = "${local.name}-db" }
}
