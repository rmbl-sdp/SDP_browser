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
      Project     = "sdp-browser"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront-scoped resources (WAF web ACL, ACM certs) must live in us-east-1.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile
  default_tags {
    tags = {
      Project     = "sdp-browser"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  container_port   = 8000
  site_bucket_name = "${var.name_prefix}-site"
  api_aliases      = var.api_domain_name == "" ? [] : [var.api_domain_name]
  site_aliases     = var.domain_name == "" ? [] : [var.domain_name]
  cors_origins     = var.domain_name == "" ? "*" : "https://${var.domain_name}"
}

module "network" {
  source         = "../../modules/network"
  name_prefix    = var.name_prefix
  container_port = local.container_port
}

module "ecr_titiler" {
  source = "../../modules/ecr"
  name   = "${var.name_prefix}-titiler"
}

module "alb_api" {
  source            = "../../modules/alb-internal"
  name_prefix       = var.name_prefix
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  security_group_id = module.network.alb_sg_id
  container_port    = local.container_port
}

module "waf" {
  source      = "../../modules/waf"
  name_prefix = var.name_prefix
  providers = {
    aws.us_east_1 = aws.us_east_1
  }
}

module "cloudfront_api" {
  source              = "../../modules/cloudfront-api"
  name_prefix         = "${var.name_prefix}-api"
  alb_dns_name        = module.alb_api.alb_dns_name
  web_acl_arn         = module.waf.web_acl_arn
  aliases             = local.api_aliases
  acm_certificate_arn = var.acm_certificate_arn
}

module "ecs_titiler" {
  source                            = "../../modules/ecs-service"
  name_prefix                       = var.name_prefix
  container_name                    = "titiler"
  image_url                         = "${module.ecr_titiler.repository_url}:${var.container_image_tag}"
  container_port                    = local.container_port
  cpu                               = var.task_cpu
  memory                            = var.task_memory
  desired_count                     = var.desired_count
  max_count                         = var.max_count
  health_check_grace_period_seconds = 120
  region                            = var.aws_region
  private_subnet_ids                = module.network.private_subnet_ids
  security_group_id                 = module.network.ecs_sg_id
  target_group_arn                  = module.alb_api.target_group_arn
  alb_listener_arn                  = module.alb_api.listener_arn
  s3_read_arns                      = var.s3_read_arns
  environment = [
    { name = "AWS_NO_SIGN_REQUEST", value = "YES" },
    { name = "AWS_DEFAULT_REGION", value = var.aws_region },
    { name = "CORS_ORIGINS", value = local.cors_origins },
    { name = "LOG_LEVEL", value = "info" },
  ]
}

module "cloudfront_site" {
  source              = "../../modules/cloudfront-site"
  name_prefix         = var.name_prefix
  bucket_name         = local.site_bucket_name
  aliases             = local.site_aliases
  acm_certificate_arn = var.acm_certificate_arn
}

module "github_oidc" {
  source                       = "../../modules/iam-github-oidc"
  name_prefix                  = var.name_prefix
  github_repo                  = var.github_repo
  allowed_refs                 = ["ref:refs/heads/main"]
  create_oidc_provider         = false
  ecr_repository_arns          = [module.ecr_titiler.repository_arn]
  ecs_service_arns             = [module.ecs_titiler.service_arn]
  site_bucket_arns             = [module.cloudfront_site.bucket_arn]
  cloudfront_distribution_arns = [module.cloudfront_api.distribution_arn, module.cloudfront_site.distribution_arn]
}
