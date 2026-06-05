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
      Sid    = "ECSService"
      Effect = "Allow"
      Action = [
        "ecs:UpdateService",
        "ecs:DescribeServices",
        "ecs:TagResource",
        "ecs:UntagResource",
      ]
      Resource = var.ecs_service_arns
    }] : [],
    # Task-definition lifecycle: ECS task-def APIs don't support resource-level
    # permissions, so Resource must be "*". Terraform replaces the task def
    # on every image change (new revision registered, old one deregistered) and
    # applies the project's default_tags to each new revision via TagResource.
    length(var.ecs_service_arns) > 0 ? [{
      Sid    = "ECSTaskDef"
      Effect = "Allow"
      Action = [
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeTaskDefinition",
        "ecs:DeregisterTaskDefinition",
        "ecs:TagResource",
        "ecs:UntagResource",
        "ecs:ListTagsForResource",
      ]
      Resource = "*"
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
      ]
      Resource = var.cloudfront_distribution_arns
    }] : [],
    length(var.tfstate_bucket) > 0 ? [{
      Sid    = "TfStateObject"
      Effect = "Allow"
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ]
      Resource = "arn:aws:s3:::${var.tfstate_bucket}/${var.tfstate_key_prefix}*"
    }] : [],
    length(var.tfstate_bucket) > 0 ? [{
      Sid      = "TfStateList"
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = "arn:aws:s3:::${var.tfstate_bucket}"
      Condition = {
        StringLike = {
          "s3:prefix" = ["${var.tfstate_key_prefix}*"]
        }
      }
    }] : [],
    length(var.tflock_table) > 0 ? [{
      Sid    = "TfLock"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
      ]
      Resource = "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.tflock_table}"
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

# Terraform's refresh phase reads every resource in the stack (VPC, IAM, EC2,
# WAF, ECR, ECS, CloudFront, ACM, autoscaling, logs, …) just to compute a plan.
# The inline write policy above is intentionally narrow; attaching the AWS-
# managed ReadOnlyAccess closes the read gap without us having to enumerate
# every Describe/Get/List action and re-touch IAM whenever a new module is
# added. Mutations remain scoped to the inline policy.
resource "aws_iam_role_policy_attachment" "deploy_read" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
