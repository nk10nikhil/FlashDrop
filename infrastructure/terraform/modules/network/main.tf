data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  availability_zones = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
  nat_indexes        = toset([for index in range(var.nat_gateway_count) : tostring(index)])
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  for_each                = toset(local.availability_zones)
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, index(local.availability_zones, each.value))
  map_public_ip_on_launch = true
  tags                    = merge(var.tags, { Name = "${var.name}-public-${each.value}" })
}

resource "aws_subnet" "private" {
  for_each          = toset(local.availability_zones)
  vpc_id            = aws_vpc.main.id
  availability_zone = each.value
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, index(local.availability_zones, each.value) + 10)
  tags              = merge(var.tags, { Name = "${var.name}-private-${each.value}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  for_each = local.nat_indexes
  domain   = "vpc"
  tags     = merge(var.tags, { Name = "${var.name}-nat-${each.key}" })
}

resource "aws_nat_gateway" "main" {
  for_each      = local.nat_indexes
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[local.availability_zones[tonumber(each.key)]].id
  depends_on    = [aws_internet_gateway.main]
  tags          = merge(var.tags, { Name = "${var.name}-nat-${each.key}" })
}

resource "aws_route_table" "private" {
  for_each = toset(local.availability_zones)
  vpc_id   = aws_vpc.main.id
  tags     = merge(var.tags, { Name = "${var.name}-private-${each.value}" })
}

resource "aws_route" "private_nat" {
  for_each               = aws_route_table.private
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[tostring(index(local.availability_zones, each.key) % var.nat_gateway_count)].id
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTPS ingress for the FlashDrop API"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${var.name}-alb" })
}

resource "aws_security_group" "application" {
  name        = "${var.name}-application"
  description = "Private API and worker tasks"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${var.name}-application" })
}

resource "aws_security_group" "data" {
  name        = "${var.name}-data"
  description = "Private PostgreSQL, Redis and MSK listener ingress from ECS tasks"
  vpc_id      = aws_vpc.main.id
  dynamic "ingress" {
    for_each = { postgres = 5432, redis = 6379, msk_iam_tls = 9098 }
    content {
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      security_groups = [aws_security_group.application.id]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${var.name}-data" })
}
