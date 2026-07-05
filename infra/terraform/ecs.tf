resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${local.name_prefix}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

# Service Connect namespace lets API tasks resolve as "api:3001" inside tasks.
resource "aws_service_discovery_http_namespace" "main" {
  name        = local.name_prefix
  description = "Tellsight private service namespace"

  tags = { Name = "${local.name_prefix}-namespace" }
}

# API task definition
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.api.repository_url}:latest"
      essential = true

      portMappings = [
        {
          name          = "api-http"
          containerPort = 3001
          hostPort      = 3001
          protocol      = "tcp"
          appProtocol   = "http"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3001" },
        {
          name  = "DATABASE_URL"
          value = "postgresql://app_user:${random_password.rds_admin.result}@${aws_db_instance.main.address}:5432/${var.rds_db_name}"
        },
        {
          name  = "DATABASE_ADMIN_URL"
          value = "postgresql://${var.rds_username}:${random_password.rds_admin.result}@${aws_db_instance.main.address}:5432/${var.rds_db_name}"
        },
        {
          name  = "REDIS_URL"
          value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379"
        }
      ]

      secrets = [
        { name = "CLAUDE_API_KEY",        valueFrom = "${aws_secretsmanager_secret.app.arn}:CLAUDE_API_KEY::" },
        { name = "CLAUDE_MODEL",          valueFrom = "${aws_secretsmanager_secret.app.arn}:CLAUDE_MODEL::" },
        { name = "STRIPE_SECRET_KEY",     valueFrom = "${aws_secretsmanager_secret.app.arn}:STRIPE_SECRET_KEY::" },
        { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:STRIPE_WEBHOOK_SECRET::" },
        { name = "STRIPE_PRICE_ID",       valueFrom = "${aws_secretsmanager_secret.app.arn}:STRIPE_PRICE_ID::" },
        { name = "GOOGLE_CLIENT_ID",      valueFrom = "${aws_secretsmanager_secret.app.arn}:GOOGLE_CLIENT_ID::" },
        { name = "GOOGLE_CLIENT_SECRET",  valueFrom = "${aws_secretsmanager_secret.app.arn}:GOOGLE_CLIENT_SECRET::" },
        { name = "JWT_SECRET",            valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3001/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  tags = { Name = "${local.name_prefix}-api-task" }
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 100
    base              = 1
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn

    service {
      port_name      = "api-http"
      discovery_name = "api"

      client_alias {
        port     = 3001
        dns_name = "api"
      }
    }
  }

  deployment_controller {
    type = "ECS"
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Prevents Terraform from reverting image tag changes made by CI.
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = { Name = "${local.name_prefix}-api" }
}

# Web task definition
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "${aws_ecr_repository.web.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        # Service Connect resolves "api" to the API service via the namespace.
        { name = "API_INTERNAL_URL", value = "http://api:3001" }
      ]

      secrets = [
        { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "web"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000 || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  tags = { Name = "${local.name_prefix}-web-task" }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 100
    base              = 1
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn
  }

  deployment_controller {
    type = "ECS"
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http, aws_ecs_service.api]

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = { Name = "${local.name_prefix}-web" }
}
