output "vpc_id" { value = aws_vpc.main.id }
output "public_subnet_ids" { value = [for az in local.availability_zones : aws_subnet.public[az].id] }
output "private_subnet_ids" { value = [for az in local.availability_zones : aws_subnet.private[az].id] }
output "alb_security_group_id" { value = aws_security_group.alb.id }
output "application_security_group_id" { value = aws_security_group.application.id }
output "data_security_group_id" { value = aws_security_group.data.id }
output "availability_zones" { value = local.availability_zones }
