variable "name_prefix" {
  type        = string
  description = "Prefix for ALB and target-group names."
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type        = string
  description = "ALB security group; should restrict ingress to CloudFront."
}

variable "container_port" {
  type    = number
  default = 8000
}

variable "health_check_path" {
  type    = string
  default = "/health"
}
