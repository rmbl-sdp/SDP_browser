variable "name_prefix" {
  type = string
}

variable "rate_limit_per_5min" {
  description = "Requests per 5-minute window per IP before the rate-limit rule blocks."
  type        = number
  default     = 10000
}
