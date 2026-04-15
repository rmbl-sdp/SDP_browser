resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.existing[0].arn
  sub_claims        = [for r in var.allowed_refs : "repo:${var.github_repo}:${r}"]
}

data "aws_iam_openid_connect_provider" "existing" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "deploy" {
  name = "${var.name_prefix}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = local.oidc_provider_arn
      }
      Condition = {
        StringLike = {
          "token.actions.githubusercontent.com:sub" = local.sub_claims
        }
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  statements = concat(
    length(var.ecr_repository_arns) > 0 ? [{
      Sid    = "ECRPush"
      Effect = "Allow"
      Action = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
      ]
      Resource = var.ecr_repository_arns
    }] : [],
    length(var.ecr_repository_arns) > 0 ? [{
      Sid      = "ECRAuth"
      Effect   = "Allow"
      Action   = "ecr:GetAuthorizationToken"
      Resource = "*"
    }] : [],
    length(var.ecs_service_arns) > 0 ? [{
      Sid    = "ECSUpdate"
      Effect = "Allow"
      Action = [
        "ecs:UpdateService",
        "ecs:DescribeServices",
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition",
      ]
      Resource = var.ecs_service_arns
    }] : [],
    length(var.ecs_service_arns) > 0 ? [{
      Sid    = "ECSPassRole"
      Effect = "Allow"
      Action = "iam:PassRole"
      Resource = [
        "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-ecs-*",
      ]
    }] : [],
    length(var.site_bucket_arns) > 0 ? [{
      Sid    = "S3Sync"
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
      ]
      Resource = concat(
        var.site_bucket_arns,
        [for arn in var.site_bucket_arns : "${arn}/*"],
      )
    }] : [],
    length(var.cloudfront_distribution_arns) > 0 ? [{
      Sid    = "CloudFrontInvalidate"
      Effect = "Allow"
      Action = [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetDistribution",
        "cloudfront:ListDistributions",
      ]
      Resource = "*"
    }] : [],
  )
}

resource "aws_iam_role_policy" "deploy" {
  count = length(local.statements) > 0 ? 1 : 0
  name  = "${var.name_prefix}-github-deploy"
  role  = aws_iam_role.deploy.id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.statements
  })
}
