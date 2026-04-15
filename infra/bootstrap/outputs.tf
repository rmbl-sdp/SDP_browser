output "state_bucket" {
  value       = aws_s3_bucket.state.id
  description = "S3 bucket to use as the Terraform backend bucket for every env."
}

output "lock_table" {
  value       = aws_dynamodb_table.locks.name
  description = "DynamoDB table to use as the Terraform state lock table."
}

output "region" {
  value = var.aws_region
}
