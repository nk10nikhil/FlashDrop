data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  db_name       = "flashdrop"
  admin_user    = "flashdrop_admin"
  application_user = "flashdrop_app"
  secret_recovery_days = var.environment == "production" ? 30 : 0
}

resource "random_password" "db_admin" {
  length  = 40
  special = false
}

resource "random_password" "db_application" {
  length  = 40
  special = false
}

resource "random_password" "redis_auth" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.name}-postgres"
  subnet_ids = var.private_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-postgres" })
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${var.name}-postgres"
  engine                      = "postgres"
  engine_version              = var.postgres_engine_version
  instance_class              = var.postgres_instance_class
  allocated_storage           = var.postgres_allocated_storage
  max_allocated_storage       = var.postgres_max_allocated_storage
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = local.db_name
  username                    = local.admin_user
  password                    = random_password.db_admin.result
  port                        = 5432
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [var.data_security_group_id]
  publicly_accessible         = false
  multi_az                    = var.multi_az
  backup_retention_period     = var.postgres_backup_days
  copy_tags_to_snapshot       = true
  deletion_protection         = var.deletion_protection
  auto_minor_version_upgrade  = true
  apply_immediately           = false
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-postgres-final"
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  tags                        = merge(var.tags, { Name = "${var.name}-postgres" })
}

resource "aws_secretsmanager_secret" "db_admin" {
  name                    = "${var.name}/database/admin"
  recovery_window_in_days = local.secret_recovery_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "db_admin" {
  secret_id = aws_secretsmanager_secret.db_admin.id
  secret_string = jsonencode({
    DATABASE_URL = "postgresql://${local.admin_user}:${random_password.db_admin.result}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${local.db_name}"
  })
}

resource "aws_secretsmanager_secret" "db_application" {
  name                    = "${var.name}/database/application"
  recovery_window_in_days = local.secret_recovery_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "db_application" {
  secret_id = aws_secretsmanager_secret.db_application.id
  secret_string = jsonencode({
    DATABASE_URL             = "postgresql://${local.application_user}:${random_password.db_application.result}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${local.db_name}"
    FLASHDROP_APP_PASSWORD   = random_password.db_application.result
  })
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name}-redis"
  subnet_ids = var.private_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name}-redis"
  description                = "FlashDrop product cache"
  engine                     = "redis"
  engine_version             = var.redis_engine_version
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [var.data_security_group_id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result
  apply_immediately          = false
  auto_minor_version_upgrade = true
  tags                       = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_secretsmanager_secret" "redis" {
  name                    = "${var.name}/redis/application"
  recovery_window_in_days = local.secret_recovery_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    REDIS_URL = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}"
  })
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/aws/msk/${var.name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_msk_cluster" "main" {
  cluster_name           = "${var.name}-msk"
  kafka_version          = var.msk_kafka_version
  number_of_broker_nodes = length(var.private_subnet_ids)
  enhanced_monitoring    = "DEFAULT"

  broker_node_group_info {
    instance_type   = var.msk_instance_type
    client_subnets  = var.private_subnet_ids
    security_groups = [var.data_security_group_id]
    storage_info {
      ebs_storage_info { volume_size = var.msk_volume_size }
    }
  }

  client_authentication {
    sasl {
      iam { enabled = true }
    }
  }
  encryption_info {
    encryption_at_rest_kms_key_arn = null
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }
  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }
  tags = merge(var.tags, { Name = "${var.name}-msk" })
}

resource "aws_secretsmanager_secret" "kafka" {
  name                    = "${var.name}/kafka/application"
  recovery_window_in_days = local.secret_recovery_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "kafka" {
  secret_id = aws_secretsmanager_secret.kafka.id
  secret_string = jsonencode({
    KAFKA_BROKERS = aws_msk_cluster.main.bootstrap_brokers_sasl_iam
  })
}
