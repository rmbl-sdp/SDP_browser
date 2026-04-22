# Remote state for the prod env. The bucket and lock table are provisioned
# by `infra/bootstrap/` before the first `terraform init` here.
terraform {
  backend "s3" {
    bucket         = "sdp-browser-tf-state"
    key            = "envs/prod/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "sdp-browser-tf-locks"
    encrypt        = true
    profile        = "sdp-browser-admin"
  }
}
