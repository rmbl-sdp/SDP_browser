variable "name_prefix" {
  type = string
}

variable "container_name" {
  type    = string
  default = "titiler"
}

variable "image_url" {
  description = "Full ECR image reference (repo-url:tag)."
  type        = string
}

variable "container_port" {
  type    = number
  default = 8000
}

variable "cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 4
}

variable "cpu_autoscale_target" {
  description = "Average-CPU-utilization target for auto-scaling (percent)."
  type        = number
  default     = 60
}

variable "health_check_grace_period_seconds" {
  type    = number
  default = 120
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "region" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "alb_listener_arn" {
  type        = string
  description = "Listener the service depends on, to avoid registering before the ALB is ready."
}

variable "environment" {
  description = "Additional environment variables for the container."
  type        = list(object({ name = string, value = string }))
  default     = []
}

variable "s3_read_arns" {
  description = "S3 bucket ARNs the task role should be granted read access to."
  type        = list(string)
  default     = []
}
