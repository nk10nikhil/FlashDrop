data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_execution" {
  name               = "${local.name}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "worker_execution" {
  name               = "${local.name}-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "migrate_execution" {
  name               = "${local.name}-migrate-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "api_execution_base" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy_attachment" "worker_execution_base" {
  role       = aws_iam_role.worker_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy_attachment" "migrate_execution_base" {
  role       = aws_iam_role.migrate_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "api_secrets" {
  name = "read-api-runtime-secrets"
  role = aws_iam_role.api_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [module.data.db_application_secret_arn, module.data.redis_secret_arn]
    }]
  })
}
resource "aws_iam_role_policy" "worker_secrets" {
  name = "read-worker-runtime-secrets"
  role = aws_iam_role.worker_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [module.data.db_application_secret_arn, module.data.redis_secret_arn, module.data.kafka_secret_arn]
    }]
  })
}
resource "aws_iam_role_policy" "migrate_secrets" {
  name = "read-migration-database-secrets"
  role = aws_iam_role.migrate_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [module.data.db_admin_secret_arn, module.data.db_application_secret_arn]
    }]
  })
}

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "worker_task" {
  name               = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "migrate_task" {
  name               = "${local.name}-migrate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}

locals {
  msk_topic_arns = [
    "${replace(module.data.msk_arn, ":cluster/", ":topic/")}/${var.msk_orders_topic}",
    "${replace(module.data.msk_arn, ":cluster/", ":topic/")}/${var.msk_dlq_topic}",
  ]
  msk_group_arn = "${replace(module.data.msk_arn, ":cluster/", ":group/")}/${var.msk_consumer_group}"
}

resource "aws_iam_role_policy" "worker_msk_iam" {
  name = "msk-orders-consumer-and-publisher"
  role = aws_iam_role.worker_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster", "kafka-cluster:WriteDataIdempotently"]
        Resource = [module.data.msk_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData", "kafka-cluster:WriteData", "kafka-cluster:CreateTopic"]
        Resource = local.msk_topic_arns
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeGroup", "kafka-cluster:AlterGroup"]
        Resource = [local.msk_group_arn]
      },
    ]
  })
}

resource "aws_iam_role_policy" "api_telemetry" {
  name = "export-api-telemetry"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:PutMetricData", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
        "xray:GetSamplingRules", "xray:GetSamplingTargets", "xray:GetSamplingStatisticSummaries",
      ]
      Resource = "*"
    }]
  })
}
resource "aws_iam_role_policy" "worker_telemetry" {
  name = "export-worker-telemetry"
  role = aws_iam_role.worker_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:PutMetricData", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
        "xray:GetSamplingRules", "xray:GetSamplingTargets", "xray:GetSamplingStatisticSummaries",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_role && var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_actions" {
  count = var.create_github_oidc_role ? 1 : 0
  name  = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Federated = local.github_provider_arn }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = local.github_subject
      } }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.create_github_oidc_role ? 1 : 0
  name  = "push-images-and-deploy-ecs"
  role  = aws_iam_role.github_actions[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
          "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        ]
        Resource = [data.aws_ecr_repository.api.arn, data.aws_ecr_repository.worker.arn]
      },
      {
        Effect = "Allow"
        Action = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:UpdateService", "ecs:RegisterTaskDefinition", "ecs:RunTask", "ecs:StopTask", "ecs:TagResource"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.api_execution.arn, aws_iam_role.worker_execution.arn, aws_iam_role.migrate_execution.arn, aws_iam_role.api_task.arn, aws_iam_role.worker_task.arn, aws_iam_role.migrate_task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}
