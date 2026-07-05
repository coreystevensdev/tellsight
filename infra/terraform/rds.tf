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

  engine         = "postgres"
  engine_version = "16"
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
  skip_final_snapshot    = true
  deletion_protection    = false

  tags = { Name = "${local.name}-db" }
}
