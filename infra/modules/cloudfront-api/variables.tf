variable "name_prefix" {
  type = string
}

variable "alb_dns_name" {
  description = "ALB DNS name to use as the CloudFront origin."
  type        = string
}

variable "web_acl_arn" {
  description = "Optional WAF web ACL ARN to associate. Leave empty for no WAF."
  type        = string
  default     = ""
}

variable "default_ttl_seconds" {
  # 7 days. Tile URLs are deterministic (same query string → same image
  # forever), so cache lifetime can be much longer than the original 24h
  # default. Improves cache hit rate across multi-day usage (e.g. someone
  # sharing a link with their lab the next day) and absorbs more of any
  # unscheduled traffic spike before it reaches origin.
  type    = number
  default = 604800
}

variable "max_ttl_seconds" {
  type    = number
  default = 604800
}

variable "aliases" {
  description = "Custom domain aliases for this distribution. Empty means use the default *.cloudfront.net."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM cert ARN in us-east-1 for the aliases. Required if aliases is non-empty."
  type        = string
  default     = ""
}
