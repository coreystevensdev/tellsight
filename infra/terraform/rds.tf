resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${local.name_prefix}-db-subnet" }
}

resource "random_password" "rds_admin" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "rds_admin" {
  name                    = "${local.name_prefix}/rds-admin"
  description             = "RDS admin credentials"
  recovery_window_in_days = 7

  tags = { Name = "${local.name_prefix}-rds-admin" }
}

resource "aws_secretsmanager_secret_version" "rds_admin" {
  secret_id = aws_secretsmanager_secret.rds_admin.id
  secret_string = jsonencode({
    username = var.rds_username
    password = random_password.rds_admin.result
  })
}

resource "aws_db_parameter_group" "main" {
  family = "postgres17"
  name   = "${local.name_prefix}-pg"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = { Name = "${local.name_prefix}-pg" }
}

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-db"

  engine               = "postgres"
  engine_version       = "17.4"
  instance_class       = var.rds_instance_class
  allocated_storage    = 20
  max_allocated_storage = 100
  storage_type         = "gp3"
  storage_encrypted    = true

  db_name  = var.rds_db_name
  username = var.rds_username
  password = random_password.rds_admin.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "${local.name_prefix}-final-snapshot"

  performance_insights_enabled = true

  tags = { Name = "${local.name_prefix}-db" }
}

