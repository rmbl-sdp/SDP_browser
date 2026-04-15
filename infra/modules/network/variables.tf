variable "name_prefix" {
  description = "Prefix applied to every resource Name (e.g. sdp-browser-staging)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones (and public/private subnet pairs) to create."
  type        = number
  default     = 2
}

variable "container_port" {
  description = "Port the ECS service listens on (used to scope the ECS SG ingress from ALB)."
  type        = number
  default     = 8000
}
