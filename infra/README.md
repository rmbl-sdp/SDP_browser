# Infrastructure

Terraform scaffolding for deploying SDP Browser to AWS. Modelled on the same persistent-container shape that `bloom_forecast_vis` settled on: TiTiler on ECS Fargate behind an internal ALB (locked to the CloudFront managed prefix list), fronted by CloudFront + WAF; the static SPA on S3 + CloudFront with OAC; GitHub Actions deploying via OIDC (no long-lived AWS keys).

```
infra/
├── bootstrap/        ← one-shot: creates S3 state bucket + DynamoDB lock table
├── modules/
│   ├── network/              ← VPC, public/private subnets, NAT, S3 gw endpoint, base SGs
│   ├── ecr/                  ← ECR repo + lifecycle (keep last 10)
│   ├── alb-internal/         ← ALB + HTTP listener + target group
│   ├── ecs-service/          ← Fargate cluster, task def, service, autoscaling, log group
│   ├── cloudfront-api/       ← CloudFront distribution fronting the ALB (tile API)
│   ├── cloudfront-site/      ← S3 + CF (OAC) for the static site
│   ├── waf/                  ← Rate limit + AWS managed rule sets (CloudFront scope)
│   └── iam-github-oidc/      ← OIDC provider + deploy role for GitHub Actions
└── envs/
    ├── staging/      ← calls the modules with staging inputs
    └── prod/
```

## Status

**Scaffold only.** Everything here `terraform validate`s without AWS credentials; nothing has been `apply`-ed. The sections below document what needs to happen when it's time to deploy.

## One-time bootstrap

Run once per AWS account to create the Terraform state bucket + lock table. Use an IAM user with admin credentials or an AWS SSO session — this module runs with **local state**.

```bash
cd infra/bootstrap
terraform init
terraform apply -var aws_region=us-east-2
terraform output
# state_bucket = "sdp-browser-tf-state"
# lock_table   = "sdp-browser-tf-locks"
```

Both env backends (`envs/staging/backend.tf`, `envs/prod/backend.tf`) are already pointing at these default names.

## First-time env bring-up

There's a chicken-and-egg with ECR: the ECS task definition wants an image tag, but the ECR repo doesn't exist yet. The deploy workflow handles this automatically with a `-target=module.ecr_titiler` apply first, then a push, then the full apply. To do it manually:

```bash
cd infra/envs/staging
terraform init
terraform apply -target=module.ecr_titiler         # creates the ECR repo
# --- push an image tagged `bootstrap` into the repo manually ---
terraform apply -var container_image_tag=bootstrap  # full stack
```

OIDC trust is scoped to `rmbl-sdp/SDP_browser`:
- Staging accepts `ref:refs/heads/main`.
- Prod accepts `ref:refs/tags/v*`.

The deploy role ARN is a Terraform output (`github_deploy_role_arn`). Set it as a **repository variable** (`AWS_DEPLOY_ROLE_ARN`) in the corresponding GitHub environment (`staging` / `prod`). These are non-secret, so a variable is fine; protect the `prod` environment with a required-reviewer rule.

## DNS + TLS

Both envs start with `domain_name = ""` → CloudFront uses its default `*.cloudfront.net` hostname, no ACM cert needed. When RMBL picks a domain:

1. Provision an ACM certificate **in us-east-1** (CloudFront-scoped) covering the site and api subdomains. Route53 DNS-validation is easiest.
2. Set the relevant `terraform.tfvars`:
   ```hcl
   domain_name         = "staging.sdp-browser.rmbl.org"
   api_domain_name     = "api-staging.sdp-browser.rmbl.org"
   acm_certificate_arn = "arn:aws:acm:us-east-1:<acct>:certificate/<id>"
   ```
3. `terraform apply`, then add Route53 A/AAAA alias records pointing at the two CloudFront distributions (their domain names are in the Terraform outputs).

## Expected costs (ballpark)

From `SPEC.md §2a`:

- Idle / low traffic: ~$150–350 / month total across both envs.
- Workshop / sustained traffic: ~$700–1 600 / month.
- S3 + CloudFront egress dominates at scale; the S3 gateway VPC endpoint is non-negotiable (saves ~$0.045/GB on every tile fetch).

## Gotchas

- **WAF scope is `CLOUDFRONT`** which means the web ACL must live in **us-east-1** regardless of where the rest of the stack runs. The `us_east_1` provider alias in each env handles that.
- **The `iam-github-oidc` module** creates a `aws_iam_openid_connect_provider` with `create_oidc_provider = true` (staging default) and reuses the existing provider with `create_oidc_provider = false` (prod default). Without that flag, a second `apply` in the same account fails.
- **`aws_ecs_service.this` has `ignore_changes = [task_definition, desired_count]`.** Terraform sets the initial task def, then GitHub Actions takes over: each deploy builds a new image and `ecs update-service --force-new-deployment`. Don't re-`apply` just to "sync" — it won't do what you expect.
- **State lock contention:** two concurrent applies against the same env will block on the DynamoDB lock. Pipelines should be serial.

## Useful outputs

Per env (`terraform output`):

- `ecr_repository_url` — where `docker push` goes.
- `ecs_cluster_name`, `ecs_service_name` — for `aws ecs update-service`.
- `api_distribution_domain`, `site_distribution_domain` — the CloudFront hostnames; used to populate `app/web/config.js`.
- `site_bucket_name` — `aws s3 sync app/web s3://…` target.
- `github_deploy_role_arn` — the value to put in the GitHub environment's `AWS_DEPLOY_ROLE_ARN` variable.
