# Remote state for the staging env. The bucket and lock table are provisioned
# by `infra/bootstrap/` before the first `terraform init` here.
terraform {
  backend "s3" {
    bucket         = "sdp-browser-tf-state"
    key            = "envs/staging/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "sdp-browser-tf-locks"
    encrypt        = true
  }
}
