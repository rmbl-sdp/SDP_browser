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

variable "tfstate_bucket" {
  description = "Name of the S3 bucket holding the remote Terraform state. Empty = skip the policy statement (no perms granted)."
  type        = string
  default     = ""
}

variable "tfstate_key_prefix" {
  description = "Object key prefix within tfstate_bucket this role may access (e.g. \"envs/staging/\"). Required when tfstate_bucket is set."
  type        = string
  default     = ""
}

variable "tflock_table" {
  description = "Name of the DynamoDB table used for state locking. Empty = skip."
  type        = string
  default     = ""
}
