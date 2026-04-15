variable "name_prefix" {
  type = string
}

variable "bucket_name" {
  description = "Name of the private S3 bucket that holds the static site bundle."
  type        = string
}

variable "aliases" {
  type    = list(string)
  default = []
}

variable "acm_certificate_arn" {
  type    = string
  default = ""
}

variable "web_acl_arn" {
  type    = string
  default = ""
}

variable "index_document" {
  type    = string
  default = "index.html"
}
