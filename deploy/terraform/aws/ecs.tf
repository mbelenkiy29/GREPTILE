resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}/web"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.name}/backend"
  retention_in_days = 30
}

data "aws_iam_policy_document" "assume_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secret_arns)
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${var.name}-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

locals {
  web_secrets     = { for k, v in var.secret_arns : k => v if k != "CONVEX_INSTANCE_SECRET" }
  web_environment = merge(var.web_env, {
    APP_URL                     = "https://${var.web_host}"
    NEXT_PUBLIC_CONVEX_URL      = "https://${var.backend_host}"
    NEXT_PUBLIC_CONVEX_SITE_URL = "https://${var.site_host}"
    OPENREVIEW_OFFLINE          = tostring(var.offline)
  })
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name         = "web"
    image        = var.web_image
    essential    = true
    portMappings = [{ containerPort = 3000 }]
    environment  = [for k, v in local.web_environment : { name = k, value = v }]
    secrets      = [for k, v in local.web_secrets : { name = k, valueFrom = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.web.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.data.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "DISABLED"
      }
    }
  }
  container_definitions = jsonencode([{
    name         = "convex-backend"
    image        = var.backend_image
    essential    = true
    portMappings = [{ containerPort = 3210 }, { containerPort = 3211 }]
    environment = [
      { name = "CONVEX_CLOUD_ORIGIN", value = "https://${var.backend_host}" },
      { name = "CONVEX_SITE_ORIGIN", value = "https://${var.site_host}" },
      { name = "INSTANCE_NAME", value = var.name },
      { name = "NODE_ACTION_USER_TIMEOUT_SECS", value = "600" },
      { name = "DISABLE_METRICS_ENDPOINT", value = "true" },
      { name = "REDACT_LOGS_TO_CLIENT", value = "true" },
    ]
    secrets     = [{ name = "INSTANCE_SECRET", valueFrom = var.secret_arns["CONVEX_INSTANCE_SECRET"] }]
    mountPoints = [{ sourceVolume = "data", containerPath = "/convex/data" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backend.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "backend"
      }
    }
  }])
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.https]
}

# One backend task at a time: Convex's local data directory must have a single writer.
resource "aws_ecs_service" "backend" {
  name                               = "${var.name}-backend"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.backend.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "convex-backend"
    container_port   = 3210
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.site.arn
    container_name   = "convex-backend"
    container_port   = 3211
  }
  depends_on = [aws_lb_listener.https]
}
