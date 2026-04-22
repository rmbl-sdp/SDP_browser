# One-shot bootstrap for remote Terraform state. Run *once per AWS account*
# with LOCAL state, then commit nothing (this module has no persistent state
# worth preserving). The resources created here are referenced by
# infra/envs/*/backend.tf.
#
#   cd infra/bootstrap
#   terraform init
#   terraform apply -var name_prefix=sdp-browser -var aws_region=us-east-2
#   terraform output   # copy outputs into each env's backend.tf

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project   = var.name_prefix
      Purpose   = "terraform-state-bootstrap"
      ManagedBy = "terraform"
    }
  }
}

# Single state bucket with environment-scoped keys (cheaper & simpler than
# one bucket per env; still completely isolated by workspace / key prefix).
resource "aws_s3_bucket" "state" {
  bucket = "${var.name_prefix}-tf-state"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

resource "aws_dynamodb_table" "locks" {
  name         = "${var.name_prefix}-tf-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
