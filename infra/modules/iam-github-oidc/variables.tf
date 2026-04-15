variable "name_prefix" {
  type = string
}

variable "github_repo" {
  description = "GitHub repository (org/name) allowed to assume the deploy role."
  type        = string
}

variable "allowed_refs" {
  description = "List of GitHub ref patterns that may assume this role. E.g. [\"ref:refs/heads/main\", \"ref:refs/tags/v*\"]."
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "create_oidc_provider" {
  description = "Create the OIDC provider resource. Set to false if another stack already created it in this account."
  type        = bool
  default     = true
}

variable "ecr_repository_arns" {
  type    = list(string)
  default = []
}

variable "ecs_service_arns" {
  type    = list(string)
  default = []
}

variable "site_bucket_arns" {
  type    = list(string)
  default = []
}

variable "cloudfront_distribution_arns" {
  type    = list(string)
  default = []
}
