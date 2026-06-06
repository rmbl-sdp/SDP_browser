# SDP Browser

Production web interface for exploring, visualizing, and extracting data from the RMBL Spatial Data Platform (a STAC catalog of Cloud-Optimized GeoTIFFs covering western Colorado research sites). Pairs with the [rSDP](https://rmbl-sdp.github.io/rSDP/) R package: researchers preview layers on the map, draw areas of interest, extract statistics or clipped rasters, and receive copy-pasteable rSDP R code to reproduce the workflow. Frontend is a build-step-free SPA on S3 + CloudFront; tile server is a persistent TiTiler on AWS ECS Fargate behind ALB + WAF.

## Layout

- `prototype/` — local Docker Compose sandbox (TiTiler + nginx). Iterate freely here against real SDP data; not wired to AWS.
- `prototype/web/js/` — ES modules consumed by `prototype/web/index.html`:
  - `catalog-static.js` — STAC walker + IndexedDB cache + faceting.
  - `idb.js` — IndexedDB wrapper.
  - `agol-auth.js` — AGOL OAuth 2.0 / PKCE flow.
  - `sites-private.js` — paged FeatureServer fetcher for the curated ResearchSites_2026 overlay.
  - `data-collection.js` — same shape as `sites-private.js` for the live Point/Line/Polygon Collection_2026 trio, plus `pointToBufferPolygon` (sub-meter GPS → 1 m circular AOI).
- `app/web/` — production SPA shipped to S3 + CloudFront. Mirrors `prototype/web/` but uses runtime `config.js` for endpoint injection (staging vs prod). No build step.
- `services/titiler/` — production TiTiler Docker image (FastAPI + rio-tiler). Runs on ECS Fargate, reads S3 anonymously, exposes `/cog/tiles/…`, `/cog/statistics`, `/cog/feature`.
- `infra/` — Terraform: `bootstrap/` (state bucket + DynamoDB lock), `modules/` (VPC, ECR, ECS, ALB, CloudFront, WAF, IAM-GitHub-OIDC), `envs/{staging,prod}`. Staging is live; prod is scaffolded.
- `.github/workflows/` — CI (`terraform fmt/validate`, Docker lint) and deploy workflows (OIDC auth, ECR push, `terraform apply`, ECS restart, S3 sync, CloudFront invalidation).
- `scripts/deploy-staging.sh` — orchestrates full staging deploy: syncs `prototype/` → `app/`, builds + pushes TiTiler image, applies Terraform, emits runtime `config.js`.
- `SPEC.md` — architecture, phased roadmap, decision rationale (why Fargate not Lambda, why static STAC today, cost notes).
- `STAC_cleanup.md` — notes on STAC catalog hygiene tasks.

## Conventions

- **Frontend:** vanilla HTML/CSS/JS (no build step). MapLibre GL JS, STAC walker in IndexedDB, URL-hash state serialization. No TypeScript / framework yet.
- **Backend:** Python 3.12, TiTiler 0.19, Uvicorn. GDAL env vars set at module load (`GDAL_CACHEMAX=200`, `VSI_CACHE`, `GDAL_HTTP_MERGE_CONSECUTIVE_RANGES`, HTTP/2). Tiles in Web Mercator; native data access in EPSG:32613. Custom `SDPReader` injects EPSG:32613 on COGs missing CRS metadata.
- **Infra:** Terraform >= 1.5, AWS provider ~5.0. Bootstrap is local state; envs use remote S3 + DynamoDB lock. GitHub OIDC for deploy credentials (no long-lived keys).
- **Containers:** `python:3.12-slim`, non-root `appuser`, healthcheck start-period >= 120s.
- **Config:** env vars (`AWS_NO_SIGN_REQUEST`, `CORS_ORIGINS`, `LOG_LEVEL`) injected via ECS task definition. Frontend reads runtime `config.js` (`TITILER`, `STAC_ROOT`, `SITES_QUERY_URL`).
- **Deployment target:** AWS us-east-2 (same region as `s3://rmbl-sdp/`). ECS Fargate (1–4 vCPU / 2–4 GB tasks, autoscale on CPU > 60%). CloudFront 24h tile TTL. WAF rate limit 10000 req/5min/IP. S3 gateway VPC endpoint for data egress.
- **Tests:** none yet; Playwright smoke tests planned for Phase 2.

## Common commands

```bash
# Local sandbox (full stack, real SDP data, no AWS)
cd prototype && docker compose up --build
# → http://localhost:8080 (frontend), http://localhost:8000 (TiTiler)

# Smoke-test production app locally against local TiTiler
docker build -t sdp-titiler services/titiler
docker run --rm -p 8000:8000 sdp-titiler
cp app/web/config.example.js app/web/config.js
python3 -m http.server 8080 --directory app/web

# Full staging deploy (requires AWS creds)
./scripts/deploy-staging.sh
# Phases: prototype → app sync, amd64 image build, ECR push, terraform apply,
# ECS force-new-deployment, S3 sync, CloudFront invalidate.

# Partial staging deploys
./scripts/deploy-staging.sh site    # frontend only
./scripts/deploy-staging.sh image   # TiTiler + ECS only

# Terraform-only
cd infra/envs/staging
terraform init && terraform plan
terraform apply
```

## Things to be careful about

- **Prototype ↔ production drift.** `app/web/` starts as a verbatim copy of `prototype/web/` and diverges; same for `services/titiler/` vs `prototype/titiler/`. `deploy-staging.sh` syncs JS modules + `catalog.json` automatically and wraps `index.html` with `config.js`. Hand-port anything else.
- **CORS / Origin header.** CloudFront strips Origin by default. The `cloudfront-api` module explicitly forwards it so TiTiler's CORS middleware can read it. If you see CORS errors, check `forwarded_values.headers = ["Origin"]` on both distributions.
- **Docker image architecture.** Fargate runs `linux/amd64`. On Apple Silicon use `docker buildx build --platform linux/amd64 …` to avoid `CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'`.
- **GDAL / VSI tuning.** Performance hinges on env vars set in `services/titiler/app.py` and the ECS task def — they must be set before `rasterio` imports. Key flags: `GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES`, `GDAL_HTTP_MULTIPLEX=YES`, `VSI_CACHE_SIZE=52428800`. See `SPEC.md §2a` and the `bloom_forecast_vis` precedent.
- **CRS assumptions.** Almost all SDP COGs are EPSG:32613 (UTM 13N). Some daily temperature products ship without embedded CRS; `SDPReader` injects it. New product family with a different native CRS → update `SDP_DEFAULT_CRS` and document in dataset metadata.
- **S3 bucket + gateway endpoint.** `rmbl-sdp` is anonymous-read. The S3 gateway VPC endpoint avoids NAT egress (~$0.045/GB saved per tile). If data moves to a private bucket, supply credentials and flip `AWS_NO_SIGN_REQUEST=NO`.
- **ECS service config.** `ignore_changes = [task_definition, desired_count]` on the service — Terraform sets the initial def, GitHub Actions takes over via `aws ecs update-service --force-new-deployment`. Manual console changes are overwritten on next `terraform apply`.
- **Terraform state locking.** Concurrent applies to the same env block on DynamoDB. One apply at a time.
- **OIDC provider already exists.** This AWS account already has a GitHub OIDC provider (from CHESS Hub). Both staging and prod set `create_oidc_provider = false`. If deploying to a new account, flip to `true`.
- **WAF scope is us-east-1.** CloudFront is global; its WAF web ACL must live in us-east-1 regardless of where the rest of the stack runs. The `us_east_1` provider alias handles this.
- **Tile cache key** includes the full query string (`url`, `rescale`, `colormap_name`, `expression`); TTL 24h. `/health` is excluded from caching to keep hit-rate metrics clean.

## Reference implementation / cross-refs

- Consumes the STAC catalog at `s3://rmbl-sdp/stac/v1/catalog.json`. Client-side static walk via `js/catalog-static.js` (Phase 1); server-side pgstac planned for Phase 3.
- Each STAC item carries `rmbl:catalog_id` (e.g. `R3D009`, `BM012`) — same IDs `pySDP` and `rSDP` use; the extraction recipe generator emits rSDP code referencing them.
- TiTiler `/cog/statistics` powers rescale auto-fit (2nd–98th percentile) and time-series zonal stats; same endpoint backs Phase 2 polygon extraction.
- Research-sites overlay comes from an ArcGIS Online public FeatureServer layer 14 (`SITES_QUERY_URL`); if it moves or becomes private, the frontend will need a server-side proxy.
- Color-vision-deficient-friendly defaults (viridis, cividis) chosen for the style panel.

## Open questions

- Should prod Terraform run from CI like staging, or stay manual?
- Analytics posture: PostHog vs CloudFront real-time logs → Athena? Not blocking v1.
- Phase 3 RDS sizing for async extraction jobs and pgstac.
