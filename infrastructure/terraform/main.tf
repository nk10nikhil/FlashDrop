data "aws_caller_identity" "current" {}
data "aws_ecr_repository" "api" {
  name = "${var.project_name}-${var.environment}-api"
}
data "aws_ecr_repository" "worker" {
  name = "${var.project_name}-${var.environment}-worker"
}

locals {
  name                  = "${var.project_name}-${var.environment}"
  tags                  = { Project = var.project_name, Environment = var.environment }
  production            = var.environment == "production"
  github_subject        = var.github_oidc_subject_override != "" ? var.github_oidc_subject_override : "repo:${var.github_repository}:environment:${var.github_environment}"
  github_provider_arn   = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : try(aws_iam_openid_connect_provider.github[0].arn, "")
  api_image             = "${data.aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
  worker_image          = "${data.aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"
  aws_account_id        = data.aws_caller_identity.current.account_id
  adot_config_api       = <<-YAML
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      sigv4auth/traces:
        region: ${var.aws_region}
        service: xray
      sigv4auth/metrics:
        region: ${var.aws_region}
        service: monitoring
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
      prometheus:
        config:
          scrape_configs:
            - job_name: flashdrop-api
              scrape_interval: 15s
              static_configs:
                - targets: ["localhost:3000"]
    processors:
      batch:
        timeout: 5s
      resource_detection:
        detectors: [env, ecs]
    exporters:
      otlp_http/traces:
        traces_endpoint: https://xray.${var.aws_region}.amazonaws.com/v1/traces
        auth:
          authenticator: sigv4auth/traces
      otlp_http/metrics:
        metrics_endpoint: https://monitoring.${var.aws_region}.amazonaws.com/v1/metrics
        auth:
          authenticator: sigv4auth/metrics
    service:
      extensions: [health_check, sigv4auth/traces, sigv4auth/metrics]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [resource_detection, batch]
          exporters: [otlp_http/traces]
        metrics:
          receivers: [otlp, prometheus]
          processors: [resource_detection, batch]
          exporters: [otlp_http/metrics]
  YAML
  adot_config_worker    = <<-YAML
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      sigv4auth/traces:
        region: ${var.aws_region}
        service: xray
      sigv4auth/metrics:
        region: ${var.aws_region}
        service: monitoring
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
      prometheus:
        config:
          scrape_configs:
            - job_name: flashdrop-worker
              scrape_interval: 15s
              static_configs:
                - targets: ["localhost:9464"]
    processors:
      batch:
        timeout: 5s
      resource_detection:
        detectors: [env, ecs]
    exporters:
      otlp_http/traces:
        traces_endpoint: https://xray.${var.aws_region}.amazonaws.com/v1/traces
        auth:
          authenticator: sigv4auth/traces
      otlp_http/metrics:
        metrics_endpoint: https://monitoring.${var.aws_region}.amazonaws.com/v1/metrics
        auth:
          authenticator: sigv4auth/metrics
    service:
      extensions: [health_check, sigv4auth/traces, sigv4auth/metrics]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [resource_detection, batch]
          exporters: [otlp_http/traces]
        metrics:
          receivers: [otlp, prometheus]
          processors: [resource_detection, batch]
          exporters: [otlp_http/metrics]
  YAML
}

module "network" {
  source                 = "./modules/network"
  name                   = local.name
  vpc_cidr               = var.vpc_cidr
  availability_zone_count = var.availability_zone_count
  nat_gateway_count      = var.nat_gateway_count
  tags                   = local.tags
}

module "data" {
  source                       = "./modules/data"
  name                         = local.name
  environment                  = var.environment
  vpc_id                       = module.network.vpc_id
  private_subnet_ids           = module.network.private_subnet_ids
  data_security_group_id       = module.network.data_security_group_id
  postgres_engine_version      = var.postgres_engine_version
  postgres_instance_class      = var.postgres_instance_class
  postgres_allocated_storage   = var.postgres_allocated_storage
  postgres_max_allocated_storage = var.postgres_max_allocated_storage
  postgres_backup_days         = var.postgres_backup_days
  redis_node_type              = var.redis_node_type
  redis_engine_version         = var.redis_engine_version
  msk_instance_type            = var.msk_instance_type
  msk_kafka_version            = var.msk_kafka_version
  msk_volume_size              = var.msk_volume_size
  msk_orders_topic             = var.msk_orders_topic
  msk_dlq_topic                = var.msk_dlq_topic
  msk_consumer_group           = var.msk_consumer_group
  multi_az                     = var.multi_az || local.production
  deletion_protection          = var.deletion_protection || local.production
  tags                         = local.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
  tags              = local.tags
}
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
  tags              = local.tags
}
resource "aws_cloudwatch_log_group" "otel_api" {
  name              = "/ecs/${local.name}/otel-api"
  retention_in_days = 14
  tags              = local.tags
}
resource "aws_cloudwatch_log_group" "otel_worker" {
  name              = "/ecs/${local.name}/otel-worker"
  retention_in_days = 14
  tags              = local.tags
}
resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name}/migrate"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_lb" "api" {
  name               = substr("${local.name}-api", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [module.network.alb_security_group_id]
  subnets            = module.network.public_subnet_ids
  enable_deletion_protection = local.production
  tags = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api-tg", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.network.vpc_id
  deregistration_delay = 30
  health_check {
    enabled             = true
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = var.acm_certificate_arn == "" ? "forward" : "redirect"
    target_group_arn = var.acm_certificate_arn == "" ? aws_lb_target_group.api.arn : null
    dynamic "redirect" {
      for_each = var.acm_certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
  tags = local.tags
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn == "" ? 0 : 1
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_wafv2_web_acl" "api" {
  name  = "${local.name}-api"
  scope = "REGIONAL"
  default_action { allow {} }
  rule {
    name     = "rate-limit-by-source-ip"
    priority = 1
    action { block {} }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-api-waf"
    sampled_requests_enabled   = true
  }
  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}
