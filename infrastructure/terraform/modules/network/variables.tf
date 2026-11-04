variable "name" {
  type = string
}
variable "vpc_cidr" {
  type = string
}
variable "availability_zone_count" {
  type    = number
  default = 2
  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "Use two or three Availability Zones."
  }
}
variable "nat_gateway_count" {
  type    = number
  default = 1
  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= var.availability_zone_count
    error_message = "NAT gateway count must be between one and the number of Availability Zones."
  }
}
variable "tags" {
  type    = map(string)
  default = {}
}
