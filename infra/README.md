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

**Staging is live.** Deployed to AWS account `254459631110` in `us-east-2`.

| Resource | Value |
|---|---|
| Site | `https://d2t01u3u0l0v6n.cloudfront.net` |
| Tile API | `https://d2mezrvzskyqgf.cloudfront.net` |
| ECR | `254459631110.dkr.ecr.us-east-2.amazonaws.com/sdp-browser-staging-titiler` |
| ECS cluster | `sdp-browser-staging-cluster` |
| ECS service | `sdp-browser-staging-svc` |
| Site S3 bucket | `sdp-browser-staging-site` |
| Deploy role | `arn:aws:iam::254459631110:role/sdp-browser-staging-github-deploy` |
| State bucket | `sdp-browser-tf-state` |
| Lock table | `sdp-browser-tf-locks` |

Prod is scaffolded but not applied.

## Prerequisites

- **AWS CLI profile** `sdp-browser-admin` configured with IAM user credentials for account `254459631110`:
  ```bash
  aws configure --profile sdp-browser-admin
  # Region: us-east-2, Output: json
  aws sts get-caller-identity --profile sdp-browser-admin
  ```
- **Terraform >= 1.5** installed.
- **Docker** with `buildx` for cross-platform builds (Mac ARM → Linux amd64).

## One-time bootstrap

Run once per AWS account to create the Terraform state bucket + lock table. Uses **local state**.

```bash
cd infra/bootstrap
terraform init
terraform apply
terraform output
# state_bucket = "sdp-browser-tf-state"
# lock_table   = "sdp-browser-tf-locks"
```

Both env backends already point at these names. The `aws_profile` defaults to `sdp-browser-admin`.

## First-time env bring-up

There's a chicken-and-egg with ECR: the ECS task definition wants an image tag, but the ECR repo doesn't exist yet.

```bash
cd infra/envs/staging
terraform init
terraform apply -target=module.ecr_titiler         # creates the ECR repo
```

Then build and push the TiTiler image. **Important: Fargate runs linux/amd64.** If you're on Apple Silicon, you must cross-compile:

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-2 --profile sdp-browser-admin \
  | docker login --username AWS --password-stdin 254459631110.dkr.ecr.us-east-2.amazonaws.com

# Build for amd64 (required even on ARM Macs) and push
ECR_URL="$(terraform output -raw ecr_repository_url)"
docker buildx build --platform linux/amd64 -t $ECR_URL:bootstrap --push ../../services/titiler
```

Then apply the full stack:

```bash
terraform apply                                    # full stack
```

This creates: VPC, NAT, ALB (locked to CloudFront prefix list), ECS Fargate service, CloudFront distributions (API + site), WAF, S3 site bucket, OIDC deploy role.

### Day-to-day deploys

Use the deploy script at the repo root — it handles syncing prototype → app (with config.js shim), building + pushing the TiTiler image, Terraform apply, ECS restart, S3 sync, and CloudFront invalidation.

```bash
# Full deploy: image + infra + site
./scripts/deploy-staging.sh

# Site-only (frontend changes, no image rebuild)
./scripts/deploy-staging.sh site

# Image-only (TiTiler changes, no site sync)
./scripts/deploy-staging.sh image
```

The script:
1. Copies `prototype/web/` → `app/web/` and applies the `config.js` shim automatically.
2. Builds the TiTiler image for `linux/amd64` (cross-compiles on ARM Macs), pushes to ECR with a timestamped tag.
3. Runs `terraform apply` to update the ECS task definition.
4. Forces a new ECS deployment and waits for stability (~2-3 min).
5. Writes `config.js` with the production API domain and syncs `app/web/` to S3.
6. Invalidates both CloudFront distributions.

### Manual site deploy (without the script)

If you only need to push frontend changes:

```bash
cd infra/envs/staging
API_DOMAIN="$(terraform output -raw api_distribution_domain)"
SITE_BUCKET="$(terraform output -raw site_bucket_name)"
SITE_DIST="$(terraform output -raw site_distribution_id)"
API_DIST="$(terraform output -raw api_distribution_id)"

cat > ../../app/web/config.js <<EOF
window.__SDP_CONFIG__ = {
  TITILER: "https://$API_DOMAIN",
  STAC_ROOT: "https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json",
  SITES_QUERY_URL: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/ResearchSites_2026_Public_View/FeatureServer/14/query",
};
EOF

aws s3 sync ../../app/web "s3://$SITE_BUCKET" --delete \
  --exclude "config.example.js" --profile sdp-browser-admin

aws cloudfront create-invalidation --distribution-id $SITE_DIST --paths "/*" --profile sdp-browser-admin
aws cloudfront create-invalidation --distribution-id $API_DIST --paths "/*" --profile sdp-browser-admin
```

## GitHub Actions OIDC

OIDC trust is scoped to `rmbl-sdp/SDP_browser`:
- Staging accepts `ref:refs/heads/main` (triggers `deploy-staging.yml`).
- Prod accepts `ref:refs/tags/v*` (triggers `deploy-prod.yml`).

### Setup

1. Go to <https://github.com/rmbl-sdp/SDP_browser/settings/environments>.
2. Create environment **`staging`**:
   - Add variable `AWS_DEPLOY_ROLE_ARN` = `arn:aws:iam::254459631110:role/sdp-browser-staging-github-deploy`
   - No protection rules needed.
3. Create environment **`prod`** (when ready):
   - Add variable `AWS_DEPLOY_ROLE_ARN` = `<terraform output from prod apply>`
   - Enable **Required reviewers** protection rule.

### Note on OIDC provider

This AWS account already has a GitHub OIDC provider (created by the CHESS Hub). Both staging and prod set `create_oidc_provider = false` to reuse it. If deploying to a **different** AWS account, flip that to `true` in the env's `main.tf`.

## DNS + TLS

**Current state:** staging is live on `sdpbrowser.org` + `api.sdpbrowser.org` with a wildcard ACM cert.

### How it was set up (reference for prod or a domain change)

1. **Request a wildcard ACM certificate in us-east-1:**
   ```bash
   aws acm request-certificate \
     --domain-name sdpbrowser.org \
     --subject-alternative-names "*.sdpbrowser.org" \
     --validation-method DNS \
     --region us-east-1 \
     --profile sdp-browser-admin
   ```

2. **DNS-validate:** open the ACM console in us-east-1, find the cert, click "Create records in Route 53." Wait 2–5 minutes for status to change to `ISSUED`.

3. **Update `terraform.tfvars`** with the domain names + cert ARN:
   ```hcl
   domain_name         = "sdpbrowser.org"
   api_domain_name     = "api.sdpbrowser.org"
   acm_certificate_arn = "arn:aws:acm:us-east-1:254459631110:certificate/861f60a7-5344-4157-86d1-ed66a19e0fdc"
   ```

4. **Apply:** `terraform apply` — updates both CloudFront distributions with the custom domains + TLS.

5. **Route53 alias records** (A + AAAA for both domains):
   ```bash
   ZONE_ID="Z0562050N5GX14WNBGVF"  # sdpbrowser.org hosted zone
   SITE_CF="d2t01u3u0l0v6n.cloudfront.net"
   API_CF="d2mezrvzskyqgf.cloudfront.net"
   CF_ZONE="Z2FDTNDATAQYW2"  # CloudFront's fixed hosted zone ID

   aws route53 change-resource-record-sets --hosted-zone-id $ZONE_ID \
     --profile sdp-browser-admin --change-batch '{
     "Changes": [
       {"Action":"UPSERT","ResourceRecordSet":{"Name":"sdpbrowser.org","Type":"A","AliasTarget":{"HostedZoneId":"'$CF_ZONE'","DNSName":"'$SITE_CF'","EvaluateTargetHealth":false}}},
       {"Action":"UPSERT","ResourceRecordSet":{"Name":"sdpbrowser.org","Type":"AAAA","AliasTarget":{"HostedZoneId":"'$CF_ZONE'","DNSName":"'$SITE_CF'","EvaluateTargetHealth":false}}},
       {"Action":"UPSERT","ResourceRecordSet":{"Name":"api.sdpbrowser.org","Type":"A","AliasTarget":{"HostedZoneId":"'$CF_ZONE'","DNSName":"'$API_CF'","EvaluateTargetHealth":false}}},
       {"Action":"UPSERT","ResourceRecordSet":{"Name":"api.sdpbrowser.org","Type":"AAAA","AliasTarget":{"HostedZoneId":"'$CF_ZONE'","DNSName":"'$API_CF'","EvaluateTargetHealth":false}}}
     ]}'
   ```

6. **Update `config.js`** (or the deploy workflow) to use `https://api.sdpbrowser.org` as the TITILER URL, re-sync to S3, and invalidate CloudFront.

### Prod domain (when ready)

When the prod stack is deployed, either:
- Point `sdpbrowser.org` at prod and move staging to `staging.sdpbrowser.org`, or
- Keep the current layout and give prod a separate domain.

The same wildcard cert covers both options.

## Expected costs (ballpark)

From `SPEC.md §2a`:

- Idle / low traffic: ~$150–350 / month total across both envs.
- Workshop / sustained traffic: ~$700–1 600 / month.
- S3 + CloudFront egress dominates at scale; the S3 gateway VPC endpoint is non-negotiable (saves ~$0.045/GB on every tile fetch).

## Gotchas discovered during first deploy

- **OIDC provider already exists**: if the AWS account already has a GitHub OIDC provider, Terraform fails with `EntityAlreadyExists`. Fix: set `create_oidc_provider = false` on the `github_oidc` module.
- **Docker image architecture**: Fargate runs `linux/amd64`. Building on Apple Silicon produces ARM images by default → `CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'`. Fix: always use `docker buildx build --platform linux/amd64`.
- **CloudFront CORS**: the site and API are on different CloudFront domains. TiTiler's CORS middleware needs the `Origin` header, but CloudFront strips it by default. Fix: `forwarded_values.headers = ["Origin"]` in the cloudfront-api module (already applied).
- **WAF scope is `CLOUDFRONT`**: the web ACL must live in **us-east-1** regardless of where the rest of the stack runs. The `us_east_1` provider alias in each env handles that.
- **`aws_ecs_service.this` has `ignore_changes = [task_definition, desired_count]`**: Terraform sets the initial task def; GitHub Actions takes over via `ecs update-service --force-new-deployment`.
- **State lock contention**: two concurrent applies against the same env will block on the DynamoDB lock.

## Useful outputs

Per env (`terraform output`):

- `ecr_repository_url` — where `docker push` goes.
- `ecs_cluster_name`, `ecs_service_name` — for `aws ecs update-service`.
- `api_distribution_domain`, `site_distribution_domain` — the CloudFront hostnames; used to populate `../app/web/config.js`.
- `site_bucket_name` — `aws s3 sync ../app/web s3://…` target.
- `github_deploy_role_arn` — the value to put in the GitHub environment's `AWS_DEPLOY_ROLE_ARN` variable.

## What talks to what

- **`../.github/workflows/deploy-*.yml`** consumes these outputs directly via `terraform output -raw` and drives the actual build + push + sync + invalidate steps. Terraform owns infrastructure shape; GitHub Actions owns the per-release image tag and the `config.js` content.
- **`../services/titiler/Dockerfile`** is the ECS task image. Environment variables are wired in `envs/*/main.tf` via `module "ecs_titiler" { environment = [...] }`.
- **`../app/web/`** is the bundle synced to the `site_bucket_name` S3 bucket, with a generated `config.js` pointing at `api_distribution_domain`.
- **`../prototype/`** does not touch this infra at all — it's a local Docker Compose stack.
