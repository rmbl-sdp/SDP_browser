variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "aws_profile" {
  description = "AWS CLI profile to use."
  type        = string
  default     = "sdp-browser-admin"
}

variable "name_prefix" {
  description = "Base prefix for all resources in this env."
  type        = string
  default     = "sdp-browser-staging"
}

variable "github_repo" {
  type    = string
  default = "rmbl-sdp/SDP_browser"
}

variable "container_image_tag" {
  description = "Tag to deploy. The deploy workflow overrides this per run; Terraform on its own uses the default as a bootstrap placeholder."
  type        = string
  default     = "bootstrap"
}

variable "domain_name" {
  description = "Public domain for the site + API. Empty means use CloudFront default *.cloudfront.net."
  type        = string
  default     = ""
}

variable "api_domain_name" {
  description = "Optional separate domain for the tile API (e.g. api.sdp-browser.rmbl.org)."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM cert ARN in us-east-1 covering domain_name + api_domain_name. Required if either is set."
  type        = string
  default     = ""
}

variable "s3_read_arns" {
  description = "S3 bucket ARNs TiTiler needs read access to."
  type        = list(string)
  default     = ["arn:aws:s3:::rmbl-sdp"]
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "desired_count" {
  description = "Autoscaling floor (min running tasks)."
  type        = number
  default     = 1
}

variable "max_count" {
  description = "Autoscaling ceiling (max running tasks)."
  type        = number
  default     = 4
}

variable "cpu_autoscale_target" {
  description = "Average-CPU target (percent) that triggers scale-out."
  type        = number
  default     = 60
}

variable "waf_rate_limit_per_5min" {
  description = "WAF requests per 5-minute window per IP before blocking."
  type        = number
  default     = 10000
}
