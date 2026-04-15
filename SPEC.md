# SDP Browser — Specification

A web interface for discovering, exploring, and extracting data from the RMBL Spatial Data Platform (SDP). Complements the [rSDP](https://rmbl-sdp.github.io/rSDP/) R package with a no-code, browser-based workflow for researchers.

- **Owner:** Rocky Mountain Biological Laboratory
- **Data:** STAC 1.1.0 catalog at `s3://rmbl-sdp/stac/v1-staging/catalog.json` (us-east-2); four sub-catalogs (GMUG, Gothic, Upper East River, Upper Gunnison). Primarily Cloud-Optimized GeoTIFF (COG) rasters. Vector layers via RMBL ArcGIS Online.
- **Audience:** Scientists and students; dozens of concurrent users with spikes during workshops and field seasons.
- **Principles:** Open-source, STAC-aligned, cloud-native, same-region with the S3 data, cacheable by default.

---

## 1. Goals & Non-Goals

### Goals
- Browse the full SDP catalog with rich metadata and previews.
- Interactively visualize rasters on a map with scientific colormaps, band math, and time-series navigation.
- Overlay ArcGIS Online vector data (research sites, sensor networks, watersheds).
- Extract data for user-defined AOIs: zonal statistics, clipped COG downloads, time-series CSVs.
- Produce reproducible "recipes" (rSDP R snippets, Python/CLI equivalents) for any extraction performed in the UI.
- Run at low idle cost; tolerate workshop traffic spikes.

### Non-Goals (v1)
- User accounts, auth'd private datasets (anonymous browsing only).
- On-the-fly geoprocessing beyond zonal stats + clip + reproject.
- Mobile-first UI (responsive is enough).
- Replacing the rSDP R package or STAC Browser — we complement them.

---

## 2. System Architecture (target state)

```
                ┌────────────────────────────────────────┐
                │          Browser (React + Vite)        │
                │  MapLibre · STAC Browser · Terra Draw  │
                └───────────────┬────────────────────────┘
                                │ HTTPS
                ┌───────────────┴────────────────────┐
                │            CloudFront              │
                │  tile cache · static UI · /api/*   │
                └───┬────────────────┬───────────┬───┘
                    │                │           │
          ┌─────────┴────┐   ┌───────┴─────┐  ┌───┴───────────┐
          │   ALB (HTTP, │   │   ALB (HTTP,│  │  S3 (static)  │
          │   CF-only)   │   │   CF-only)  │  │  UI bundle +  │
          └──────┬───────┘   └──────┬──────┘  │  STAC JSON    │
                 │                  │         └───────────────┘
          ┌──────┴───────┐   ┌──────┴───────┐
          │  TiTiler on  │   │ stac-fastapi │
          │   Fargate    │   │  + pgstac    │
          │ (persistent) │   │  on Fargate  │
          └──────┬───────┘   └──────┬───────┘
                 │ range GETs       │
                 │ via /vsicurl/    │
                 │ (VPC S3 gw ep.)  │
          ┌──────┴──────────────────┴──────┐
          │   s3://rmbl-sdp  (COGs)        │
          └────────────────────────────────┘

  Async extraction path: UI → ALB → SQS → Fargate Spot worker
                         → writes output COG/CSV to s3://rmbl-sdp-extracts
                         → returns pre-signed URL
```

### Key decisions
- **Persistent containers, not Lambda, for tile serving.** Prior RMBL project `bloom_forecast_vis` settled on ECS Fargate after finding that Lambda is a poor fit for rio-tiler/TiTiler workloads: LRU tile caches, GDAL block caches (`GDAL_CACHEMAX`, `VSI_CACHE_SIZE`), long startup (mask / metadata prefetch), and `/vsicurl/` connection pooling all depend on a long-lived process. We adopt the same architecture from day one and only reach for Lambda for genuinely stateless one-off endpoints.
- **ALB restricted to the CloudFront managed prefix list.** No direct public access to Fargate; TLS terminates at CloudFront, HTTP from CloudFront → ALB inside the VPC. Same pattern as bloom_forecast_vis.
- **WAF** (rate limit, managed rule sets) attached to the CloudFront distribution.
- **Same region (us-east-2)** for every compute component touching S3. S3 gateway VPC endpoint is mandatory (avoids NAT egress costs).
- **CloudFront in front of everything public.** Tiles, UI, and STAC JSON; 24 h default TTL on tiles with full-query-string cache key.
- **Start static for STAC**; move to pgstac only when we need server-side filtering or titiler-pgstac mosaics.
- **Infra-as-code in Terraform**, porting the `bloom_forecast_vis/deployed/terraform/` structure. GitHub Actions + OIDC for deploys (no long-lived AWS keys). Open question: if the broader RMBL org standardizes on CDK later, the Terraform can be migrated, but matching the in-house pattern now minimizes reinvention.

---

## 2a. Lessons carried over from `bloom_forecast_vis`

`bloom_forecast_vis` (/Users/ian/code/bloom_forecast_vis) is the closest in-house precedent — a FastAPI + rio-tiler tile server for RMBL COGs on S3, behind ALB + CloudFront + WAF. These are the concrete learnings we adopt:

1. **Lambda is the wrong shape for COG tile serving at RMBL.** The project explicitly runs on Fargate because:
   - Python-side LRU caches (`functools.lru_cache(maxsize=4096)` on render functions) and GDAL block caches (`GDAL_CACHEMAX`, `VSI_CACHE_SIZE`) deliver their value only across many requests in the same process.
   - Startup work (catalog walks, mask downloads, metadata prefetch) takes 30–90 s — past Lambda's init budget.
   - `/vsicurl/` range-request coalescing (`GDAL_HTTP_MERGE_CONSECUTIVE_RANGES`, `GDAL_HTTP_MULTIPLEX`) depends on persistent HTTP/2 connections.
   - Blocking GDAL calls are offloaded via `ThreadPoolExecutor`; Lambda's concurrency-1 model defeats this.
2. **ALB restricted to the CloudFront prefix list** prevents direct access to the origin; CloudFront is the only public ingress.
3. **Rasterio + rio-tiler via PyPI wheels** ship a bundled GDAL — no system `libgdal` install in the container. Keeps the image small and reproducible.
4. **Single Uvicorn process per task; scale via Fargate task count**, not in-container workers. Each extra worker would duplicate the caches and fight for the GDAL block budget.
5. **Validate inputs before the cache** (asset/collection ID against an allow-list, zoom/bbox bounds) to prevent cache-pollution abuse.
6. **Download small, hot side-files to local disk at startup** (e.g. domain masks) rather than streaming through `/vsicurl/` every request.
7. **CRS mixing is tolerable** — rio-tiler reprojects transparently — but document native CRS per product; any worker-side code that skips rio-tiler must handle it.
8. **Terraform + GH Actions OIDC** (not CDK, not long-lived keys) is the proven deploy path; reuse `vpc.tf`, `ecs.tf`, `alb.tf`, `cloudfront.tf`, `waf.tf`, `iam.tf`, `ecr.tf`, the deploy workflow, and the Dockerfile.
9. **WAF default:** start at 10 000 req/5 min/IP (the current bloom_forecast_vis setting after it was raised from 2 000) and tune from CloudFront logs.
10. **Frontend tricks worth porting:** URL-hash shareable state, prefetch for adjacent time slices, a "layer generation counter" to discard stale tile layers during fast scrubbing, click-to-query popups with sparkline charts.

### Cost implication
Fargate replaces Lambda in the cost table from the research stage: a 24/7 baseline of one 1 vCPU / 2 GB task is ~$30–50/mo per service (TiTiler, eventually stac-api). Workshop-time autoscale to 4–6 tasks adds another $100–200/mo. CloudFront egress still dominates at scale. Overall envelope is similar to the earlier estimate — the shape is flatter (no near-zero idle, but no cold-start spikes either) and the p95 latency is more predictable.

---

## 3. Repository layout

The actual on-disk layout as of the current `main`. Ticks (✅) mark what is
built today; stubs (🟡) are planned but not scaffolded; (➖) is deliberately
deferred to later phases.

```
SDP_browser/
├── SPEC.md                  # this file
├── README.md                                                ✅
├── prototype/                                               ✅ local sandbox
│   ├── docker-compose.yml   # titiler + web nginx sidecar
│   ├── titiler/             # Dockerfile + app.py (GDAL env, CORS middleware)
│   └── web/                 # MapLibre single-page UI + js/idb.js + js/catalog-static.js
├── app/                                                     ✅ production frontend
│   ├── README.md
│   └── web/                 # verbatim copy of prototype/web + runtime config.js shim
│       └── config.example.js  # committed; real config.js is deploy-time generated
├── services/
│   ├── titiler/                                             ✅ Docker image (shared shape with prototype)
│   ├── stac-api/                                            ➖ stac-fastapi + pgstac (phase 3)
│   └── extract-worker/                                      ➖ rioxarray + exactextract + odc-stac (phase 3)
├── infra/                                                   ✅ Terraform
│   ├── README.md
│   ├── bootstrap/           # one-shot S3 state bucket + DynamoDB lock
│   ├── modules/             # network, ecr, alb-internal, ecs-service,
│   │                        # cloudfront-api, cloudfront-site, waf, iam-github-oidc
│   └── envs/
│       ├── staging/         # calls modules with staging inputs; main branch target
│       └── prod/            # tag v* target, environment-gated in GitHub
├── tools/
│   ├── cog-audit/                                           🟡 rio cogeo validate runner (phase 0)
│   └── stac-loader/                                         ➖ pgstac ingest (phase 3)
├── .github/workflows/                                       ✅ ci.yml, deploy-staging.yml, deploy-prod.yml
└── .githooks/                                               ✅ pre-commit secret + size guardrails
```

`prototype/` stays as the sandbox — changes there don't reach production until
ported into `app/web/` and `services/titiler/`. `app/web/` currently mirrors
`prototype/web/` verbatim; the duplication will shrink when we pick up a
bundler, but until then copying is explicit and predictable.

---

## 4. Cross-cutting standards

- **Languages:** TypeScript for UI; HCL (Terraform) for infra; Python 3.12 for tile server, workers, and any TiTiler extensions.
- **Base image:** `python:3.12-slim` + minimal system deps (`libexpat1`, `curl`), non-root `appuser`, health check with ≥120 s start-period (port from bloom_forecast_vis Dockerfile).
- **GDAL env (set before importing rasterio / rio-tiler)** — standard tuning from bloom_forecast_vis:
  - `GDAL_CACHEMAX=200` (MB)
  - `VSI_CACHE=TRUE`, `VSI_CACHE_SIZE=52428800` (50 MB)
  - `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR`
  - `CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.tiff,.vrt,.json`
  - `GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES`
  - `GDAL_HTTP_MULTIPLEX=YES`, `GDAL_HTTP_VERSION=2`
- **In-process tile cache:** wrap render paths with `functools.lru_cache(maxsize=~4096)` keyed by validated inputs; separate `ThreadPoolExecutor`s for tile rendering (≈4 workers) and heavier endpoints like `/statistics` or timeseries (≈8 workers) so one doesn't starve the other.
- **Input validation before cache lookup:** reject unknown asset/collection IDs, out-of-range zoom, malformed bboxes — prevents cache-pollution abuse (pattern from bloom_forecast_vis species allow-list).
- **Lint/format:** `ruff` + `black` (Python), `eslint` + `prettier` (TS), `terraform fmt` + `tflint`.
- **Tests:** `pytest` for services; `vitest` + Playwright for web; `terraform validate` + `tfsec` in CI.
- **CI:** GitHub Actions via **OIDC** (no long-lived AWS keys). PR: lint, typecheck, unit tests, `terraform plan`. Merge to `main` → build & push Docker image to ECR, `aws ecs update-service --force-new-deployment`, `aws ecs wait services-stable`, CloudFront invalidation. Tag → prod promotion.
- **Environments:** `staging` (current `v1-staging` catalog) and `prod` (future stable catalog). Separate AWS accounts preferred; separate Terraform workspaces/state at minimum.
- **Observability:** CloudWatch metrics + structured JSON logs; CloudFront real-time logs → S3 → Athena/QuickSight for tile hit-rate analysis; Sentry for frontend errors; ETag on tile responses for debuggability and conditional GETs.
- **Security:** no auth in v1; all data public. WAF attached at CloudFront with rate limit (start 10 000 req/5 min/IP — match the current bloom_forecast_vis setting) + AWS managed rule sets. ALB security group accepts traffic **only** from the CloudFront managed prefix list. Secrets in AWS Secrets Manager (pgstac creds). CORS allow-list restricted to the CloudFront domain and localhost dev hosts.
- **Coordinate systems:** serve tiles in Web Mercator (EPSG:3857); retain native CRS (often EPSG:32613) for extractions and downloads. Rely on rio-tiler's transparent reprojection but assert the CRS explicitly where custom processing runs.

---

## 5. Phase 0 — COG audit & baseline

**Goal:** ensure every COG in the catalog renders fast enough that application-layer optimization is worthwhile.

### Scope
1. Enumerate every `data` asset in the staging catalog (walk STAC tree; reuse `sdp_get_catalog()` logic).
2. Run `rio cogeo validate` and `gdalinfo -json` on each; record:
   - block size, overview levels, compression, predictor, `IFD` ordering, presence of sidecar stats, file size.
3. Classify each asset as **good / needs-rebuild / broken**.
4. Rebuild offenders with a standard recipe.

### Standard COG recipe
- Continuous float rasters: `rio cogeo create --cog-profile deflate --blocksize 512 --overview-resampling average --overview-level 6 --co PREDICTOR=3 --co ZLEVEL=9` (or ZSTD where available).
- Continuous 8/16-bit: same but `--cog-profile lzw` or `deflate`.
- Categorical rasters: `--overview-resampling nearest`, `--co PREDICTOR=2`.
- RGB visual products (NAIP, orthos): `--cog-profile webp --overview-resampling average`.
- Validate with `rio cogeo validate` and confirm `tippecanoe`-style IFD ordering (overviews first).

### Deliverables
- `tools/cog-audit/` CLI that produces `audit-report.csv` + per-asset JSON.
- A CloudWatch dashboard listing non-compliant assets.
- A documented rebuild SOP in `docs/cog-recipe.md`.
- **Exit criteria:** 100% of non-deprecated assets pass `rio cogeo validate`; median TiTiler tile latency (cold) under 1.0 s against a sample of 50 random assets.

**Why this is Phase 0:** TiTiler and all client libraries assume well-formed COGs. Fixing structure before provisioning infra avoids chasing infra phantoms later.

---

## 6. Phase 1 — MVP browser

**Goal:** ship a public, read-only web app where a researcher can find a dataset, see it on a map, and understand its metadata.

### Features
- **Catalog browse:** embed STAC Browser for hierarchy + metadata. Link from each item to the map view.
- **Map view:** MapLibre GL JS with:
  - basemap switcher (Esri World Imagery, USGS topo, OSM),
  - one or more SDP raster layers rendered via TiTiler (`/cog/tiles/{z}/{x}/{y}.png?url=…&rescale=…&colormap_name=…`),
  - legend derived from TiTiler `/cog/statistics` + colormap,
  - opacity / visibility controls, layer ordering.
- **Footprint view** from STAC item `bbox` / `geometry`.
- **Share URL** encoding viewport, layer set, and styling (client-side state → URL hash).
- **Deep links** from rSDP docs / STAC Browser into specific map views.

### Back-end components (Phase 1)
- **TiTiler on ECS Fargate**, 1 vCPU / 2 GB per task (matches bloom_forecast_vis baseline), 1 task min / 4 max, target-tracking autoscale on CPU ≥ 60%.
  - Uvicorn single-process per task (horizontal scale via task count, not in-container workers — keeps GDAL + LRU caches hot per process).
  - `/health` endpoint with 30 s interval, 5 s timeout, 120 s grace period (mask / metadata prefetch takes real time).
  - `LRU_CACHE_MAXSIZE=4096` on the tile render function; `ThreadPoolExecutor(max_workers=4)` for tile I/O, separate 8-worker pool for `/statistics` / timeseries.
- **Internal ALB**, HTTP-only listener on port 80, security group locked to the CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`).
- **CloudFront** distribution with:
  - cache key: full query string (`url`, `rescale`, `colormap_name`, `expression`),
  - `Cache-Control: public, max-age=86400, s-maxage=604800`; 24 h CF default TTL,
  - WAF association, compression enabled, `/health` excluded from caching,
  - price class NA+EU,
  - TLSv1.2+ to origin.
- **Static STAC** served from the existing S3 bucket, fronted by a separate CloudFront distribution (or extra behavior on the same one).
- **Static UI** hosted on S3 + CloudFront.

### Front-end notes
- React 18 + Vite + TypeScript; Tailwind + shadcn/ui for the chrome.
- State: Zustand store keyed by a URL-serializable `ViewState` type (`{bbox, layers[], basemap, time}`).
- STAC client: `@radiantearth/stac-ts` or plain fetch; cache item docs in IndexedDB.
- TiTiler client: thin wrapper generating signed tile URLs and `/statistics`, `/bounds`, `/info` calls.
- Accessibility: keyboard-navigable layer list; colormap picks respect color-vision-deficient palettes (viridis, cividis default).

### Deliverables
- `web/` app deployed at `staging.sdp-browser.rmbl.org` (or similar).
- `services/titiler/` Docker image (port Dockerfile from `bloom_forecast_vis/deployed/Dockerfile`).
- `infra/` Terraform for VPC, ECS, ALB, CloudFront+WAF, static-site — structure ported from `bloom_forecast_vis/deployed/terraform/`.
- GitHub Actions workflow (ported from `bloom_forecast_vis/.github/workflows/deploy.yml`): OIDC auth, ECR push, `aws ecs wait services-stable`, CloudFront invalidation.
- Smoke-test Playwright suite covering: load catalog, open item, render tiles, share URL round-trips.
- **Exit criteria:** render any catalog item end-to-end; p50 warm tile ≤ 100 ms (CloudFront hit), p95 cold ≤ 1.5 s; Lighthouse performance ≥ 85.

---

## 7. Phase 2 — AOI extraction (small jobs)

**Goal:** let a user draw a polygon and immediately get zonal statistics or a clipped raster, plus a copy-pasteable rSDP/Python recipe.

### Features
- **AOI tools:** Terra Draw polygon / rectangle / circle; upload GeoJSON, KML, or shapefile (zipped). Display area in ha/km².
- **Zonal stats panel:** POST geometry to TiTiler `/cog/statistics?url=…` (or `/cog/feature`); show min/mean/median/max/stddev + histogram sparkline per band. Works for single-layer and multi-band expressions.
- **Time-series extraction (small):** for time-series STAC items with daily/yearly layers, iterate client-side over `date_start..date_end` (≤ 90 layers) calling `/cog/statistics` per layer; stream results into a table + chart (Observable Plot or Recharts). Bigger ranges → Phase 3.
- **Clipped download:** `/cog/feature.tif` for small AOIs (< 50 MB response). Fall back to async for bigger.
- **Recipe generator:** every extraction produces an R snippet using `rSDP::sdp_extract_data()` and a Python `rioxarray` equivalent. One-click copy; downloadable as `.R` / `.py`.
- **ArcGIS Online overlays:** add RMBL feature services by URL; parse `?f=geojson`; cache to IndexedDB; clip AOI to polygons, show attribute table.

### Back-end components (Phase 2)
- TiTiler config bumped: enable `/cog/statistics`, `/cog/feature`, and `/cog/feature.tif`. Because we are on Fargate (not Lambda), there is no 6 MB / 29 s payload limit — tune ALB idle timeout (e.g. 120 s) and `uvicorn --timeout-keep-alive` to match. Bump Fargate task size to 2 vCPU / 4 GB if `/statistics` p95 regresses.
- WAF rule: tighter rate limit (e.g. 60 req/min/IP) on `*/statistics` and `*/feature*` paths; generous limit on tile paths.
- Frontend threshold check (layer count × polygon pixel estimate) that routes oversized requests to the Phase 3 async path once available.

### Deliverables
- `web/src/components/Extract/` with AOI tools, stats panel, time-series table, recipe export.
- Integration tests with fixture COGs (tiny test rasters checked in to `tools/fixtures/`).
- **Exit criteria:** draw-to-result under 3 s for a 1 km² AOI on 3 m rasters; recipe reproduces UI result exactly when run in R.

---

## 8. Phase 3 — STAC API + async extractions at scale

**Goal:** handle large extractions, time-series spanning hundreds of layers, and richer catalog queries.

### STAC API
- Deploy **stac-fastapi + pgstac** on Fargate (1 task, autoscale to 4 on CPU > 60%).
- Postgres via RDS `db.t4g.small` (gp3 50 GB) with pgstac extension.
- Loader pipeline: GitHub Action running `pypgstac load collections/items` against staging on every catalog change in the upstream S3 bucket (CloudWatch event → Lambda → pgstac RPC).
- Public read endpoint fronted by CloudFront; `/search`, `/collections`, CQL2 filtering on `datetime`, `bbox`, `properties.sdp:domain`, `properties.sdp:product_type`.
- Add **[titiler-pgstac](https://github.com/stac-utils/titiler-pgstac)** for dynamic mosaics (e.g. "latest NDVI over East River", "median 2018–2024 snow-cover duration").

### Async extraction service
- **API:** `POST /extract` on the existing Fargate API service (not API Gateway) → validates job, writes to DynamoDB (`job_id`, status, params, result_url), enqueues SQS message, returns `202 {job_id}`.
- **Worker:** Fargate Spot task (2 vCPU / 4 GB, scale 0–10) running a Python container with `rioxarray`, `odc-stac`, `exactextract`, `rasterio`. Polls SQS, runs job, writes outputs to `s3://rmbl-sdp-extracts/{job_id}/`, updates DynamoDB, emits EventBridge event.
- **Status polling:** `GET /extract/{job_id}` → `{status, progress, result_url?, recipe}`; frontend uses server-sent events or polling.
- **Result formats:** clipped COG(s), GeoTIFF stack, CSV of per-polygon stats, Zarr for large cubes.
- **Retention:** extracts auto-expire after 7 days via S3 lifecycle rule; recipe is preserved in DynamoDB for 90 days.
- **Cost controls:** per-IP job quota (5 active), max output size 2 GB, max raster-pixel-count guard.

### Frontend additions
- "Send to background job" button whenever requested extent exceeds thresholds (layer count, pixel count, or response size estimate).
- Jobs panel (persistent across sessions via `job_id` in URL) with status, result download, recipe, retry.
- Mosaic layer picker driven by titiler-pgstac search parameters.

### Deliverables
- `infra/lib/stac-api.ts`, `infra/lib/extraction.ts` CDK stacks.
- `workers/extract/` image published to ECR; integration tests on small fixture catalog.
- Admin runbook for pgstac ingestion, backups, and reindexing.
- **Exit criteria:** a 50-polygon × 1 000-layer zonal-stats job completes in ≤ 15 min and ≤ $0.50 of compute; STAC API p95 ≤ 300 ms; titiler-pgstac mosaic tile p95 (warm) ≤ 150 ms.

---

## 9. Phase 4 — Polish, scale, and operations

**Goal:** harden for real traffic, especially workshop spikes; add analytics and pre-rendered "hero" content.

### Work items
- **Load test:** k6 scenario simulating 100 concurrent users panning/zooming over five popular layers; tune CloudFront TTLs, Lambda concurrency / provisioned concurrency, Fargate autoscaling targets.
- **Pre-render hero tiles:** for the top ~20 most-viewed layers, generate z5–z14 tiles with [cogeo-mosaic](https://github.com/developmentseed/cogeo-mosaic) or AWS Batch + gdal2tiles and upload to S3 behind CloudFront — bypasses TiTiler entirely.
- **Analytics:** CloudFront real-time logs → Athena + QuickSight dashboards (tile requests, unique viewers, top items, extraction job throughput). PostHog or Plausible for frontend product analytics.
- **Error budgets & alarms:** CloudWatch alarms on TiTiler 5xx rate (> 1%), Fargate task failures, SQS DLQ depth; PagerDuty or email integration.
- **Docs site:** MkDocs or Starlight site covering user guide, recipe gallery, and REST/STAC API reference; cross-link rSDP docs.
- **Accessibility + i18n pass:** WCAG 2.1 AA; structure strings for future Spanish translation.
- **Governance:** publish a data-use & citation page auto-generated from STAC `sci:citation` fields.
- **Exit criteria:** 200-user simulated workshop sustains p95 tile latency ≤ 250 ms; alert rules green for 30 days.

---

## 10. Milestones (indicative)

| Phase | Target duration | Dependencies | Status |
|---|---|---|---|
| 0. COG audit | 2–3 weeks | rSDP catalog walk | not started |
| 1. MVP browser (interface) | 6–8 weeks | Phase 0; Terraform baseline | **sandboxed** — all MVP features built in `prototype/`; infra scaffolded; AWS apply pending account + domain |
| 2. AOI extraction (small) | 4–6 weeks | Phase 1 | **sandboxed** — AOI bbox, histograms, GeoTIFF/PNG subset, R snippet export all live in `prototype/` |
| 3. STAC API + async jobs | 6–8 weeks | Phase 2 | not started; client-side STAC walk is sufficient for current catalog size |
| 4. Polish & scale | ongoing | Phase 3 | not started |

Total to a "complete" v1: roughly **5–6 months of one engineer**, faster with parallelism between infra and UI.

### Immediate path to first live deploy

1. Choose an AWS account + region (us-east-2 to match `rmbl-sdp`).
2. Run `infra/bootstrap/` to provision the Terraform state bucket + lock table.
3. Create `staging` / `prod` GitHub environments; drop `AWS_DEPLOY_ROLE_ARN` in as a non-secret variable after the first Terraform apply prints it.
4. Let CI take over: `git push origin main` → staging deploys automatically.

---

## 11. Open questions

Things still blocking the jump from scaffold to a live URL:

1. **Hosting account:** does RMBL have an existing AWS account with billing alerts and org policies, or do we set up a new sub-account for SDP Browser?
2. **Domain & TLS:** preferred subdomain under `rmbl.org`? Route53 or external DNS? Until this lands, staging + prod will come up on `*.cloudfront.net` URLs.
3. **Budget ceiling:** target monthly AWS spend (shapes autoscaling caps in `infra/envs/*/terraform.tfvars`).
4. **Workshop calendar:** known dates we should pre-scale for.

Longer-horizon, not blocking an initial deploy:

5. **Analytics & privacy posture:** okay to set cookies / use PostHog, or strictly log-based (CloudFront real-time logs → Athena)?
6. **ArcGIS Online tokens:** the research-sites overlay is public today. If private services get added, we need a server-side proxy, not in-browser tokens.
7. **Citation & license surfacing:** is there a canonical citation string per product, or derived per-collection?
8. **STAC catalog cleanup:** some items are serialized with bare `NaN` / `Infinity` tokens (not valid JSON); we work around it in the browser walker but upstream is the right fix.

---

## 12. References

- rSDP package — https://rmbl-sdp.github.io/rSDP/
- Existing STAC catalog — https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1-staging/catalog.json
- TiTiler — https://developmentseed.org/titiler/
- titiler-pgstac — https://github.com/stac-utils/titiler-pgstac
- stac-fastapi — https://github.com/stac-utils/stac-fastapi
- pgstac — https://github.com/stac-utils/pgstac
- eoAPI reference stack — https://eoapi.dev
- STAC Browser — https://github.com/radiantearth/stac-browser
- maplibre-cog-protocol — https://github.com/geomatico/maplibre-cog-protocol
- Terra Draw — https://github.com/JamesLMilner/terra-draw
- exactextract — https://github.com/isciences/exactextract
- Microsoft Planetary Computer data-access — https://planetarycomputer.microsoft.com/docs/concepts/data-access/
