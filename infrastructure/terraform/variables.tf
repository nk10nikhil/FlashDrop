variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "project_name" {
  type    = string
  default = "flashdrop"
}
variable "environment" {
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging, or production."
  }
}
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "availability_zone_count" {
  type    = number
  default = 2
}
variable "nat_gateway_count" {
  type    = number
  default = 1
}
variable "acm_certificate_arn" {
  type    = string
  default = ""
  validation {
    condition     = var.environment != "production" || length(var.acm_certificate_arn) > 0
    error_message = "Production requires an ACM certificate ARN for HTTPS."
  }
}
variable "waf_rate_limit" {
  type    = number
  default = 2000
}

variable "api_image_tag" {
  type    = string
  default = "bootstrap"
}
variable "worker_image_tag" {
  type    = string
  default = "bootstrap"
}
variable "otel_collector_image" {
  type    = string
  default = "public.ecr.aws/aws-observability/aws-otel-collector:v0.51.0"
}

variable "auth_jwks_url" { type = string }
variable "auth_issuer" { type = string }
variable "auth_audience" { type = string }
variable "cors_origins" {
  type    = string
  default = ""
}

variable "postgres_engine_version" {
  type    = string
  default = "17.6"
}
variable "postgres_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "postgres_allocated_storage" {
  type    = number
  default = 100
}
variable "postgres_max_allocated_storage" {
  type    = number
  default = 500
}
variable "postgres_backup_days" {
  type    = number
  default = 14
}
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "redis_engine_version" {
  type    = string
  default = "7.1"
}
variable "msk_instance_type" {
  type    = string
  default = "kafka.m7g.large"
}
variable "msk_kafka_version" {
  type    = string
  default = "3.8.x"
}
variable "msk_volume_size" {
  type    = number
  default = 100
}
variable "msk_orders_topic" {
  type    = string
  default = "orders.created.v1"
}
variable "msk_dlq_topic" {
  type    = string
  default = "orders.created.dlq.v1"
}
variable "msk_consumer_group" {
  type    = string
  default = "flashdrop-orders-v1"
}
variable "multi_az" {
  type    = bool
  default = true
}
variable "deletion_protection" {
  type    = bool
  default = false
}

variable "api_desired_count" {
  type    = number
  default = 2
}
variable "api_min_capacity" {
  type    = number
  default = 2
}
variable "api_max_capacity" {
  type    = number
  default = 20
}
variable "worker_desired_count" {
  type    = number
  default = 2
}
variable "worker_min_capacity" {
  type    = number
  default = 2
}
variable "worker_max_capacity" {
  type    = number
  default = 30
}
variable "api_cpu" {
  type    = number
  default = 1024
}
variable "api_memory" {
  type    = number
  default = 3072
}
variable "worker_cpu" {
  type    = number
  default = 1024
}
variable "worker_memory" {
  type    = number
  default = 4096
}
variable "worker_lag_target" {
  type    = number
  default = 1000
}
variable "api_requests_per_target" {
  type    = number
  default = 1000
}

variable "create_github_oidc_role" {
  type    = bool
  default = false
}
variable "github_repository" {
  type    = string
  default = ""
}
variable "github_environment" {
  type    = string
  default = "production"
}
variable "github_oidc_subject_override" {
  type    = string
  default = ""
}
variable "github_oidc_provider_arn" {
  type    = string
  default = ""
}
