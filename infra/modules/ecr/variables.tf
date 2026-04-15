variable "name" {
  description = "ECR repository name."
  type        = string
}

variable "keep_last_images" {
  description = "Number of recent images to retain before expiration."
  type        = number
  default     = 10
}
