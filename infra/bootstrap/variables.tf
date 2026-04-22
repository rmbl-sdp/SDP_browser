variable "name_prefix" {
  description = "Project-wide prefix. Resources are named <prefix>-tf-state / <prefix>-tf-locks."
  type        = string
  default     = "sdp-browser"
}

variable "aws_region" {
  description = "AWS region for the state bucket + lock table."
  type        = string
  default     = "us-east-2"
}

variable "aws_profile" {
  description = "AWS CLI profile to use."
  type        = string
  default     = "sdp-browser-admin"
}
