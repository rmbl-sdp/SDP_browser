# SDP Browser — Roadmap

Living document tracking what's shipped, what's next, and what's on the horizon. See [`SPEC.md`](./SPEC.md) for the full architecture and phased plan; this file focuses on concrete next steps and their priority.

## Shipped

### Prototype (local sandbox)
- STAC catalog discovery: client-side BFS walk with IndexedDB cache, faceted search (domain / release / type / resolution / bands), card grid with collection thumbnails, item detail with "Add to Map" + "Open in STAC Browser".
- Active layers: drag-to-reorder, per-layer styling (colormap with gradient picker, rescale with auto 2nd–98th percentile, opacity, band selection for multiband, year scrubber for time-series).
- AOI extraction: draw bbox, per-band histograms (colormap-matched), GeoTIFF/PNG subset download, R and Python code snippet copy, Jupyter notebook (.ipynb) and R Markdown (.Rmd) download with metadata, visualization, and export cells.
- Map overlays: Esri labels + roads, RMBL ArcGIS research sites (click-to-AOI).
- URL hash: full session state (layers, view, discovery filters) is shareable and survives reload.
- Collapsible / resizable sidebar, RMBL branding.
- `/cog/info` probe to fix STAC items that under-report band count.

### Infrastructure scaffold
- `services/titiler/`: production Docker image with env-configurable CORS.
- `app/web/`: production frontend with runtime `config.js` shim.
- `infra/`: Terraform modules (network, ECR, ALB, ECS, CloudFront API + site, WAF, IAM OIDC), bootstrap for S3 state backend, staging + prod env compositions. All `terraform validate` clean.
- `.github/workflows/`: CI (fmt, validate, docker build) + OIDC deploy workflows (staging on main, prod on tag).
- `.githooks/pre-commit`: secret + size guardrails.

### CHESS Analysis Hub environment
- `pysdp[all]` added to pip deps.
- `rSDP` installed via `remotes::install_github` in Docker build.

---

## Near-term (next up)

### First live deploy
- Choose AWS account + region (us-east-2 recommended for S3 co-location).
- Run `infra/bootstrap/` to create state bucket + lock table.
- First `terraform apply` for staging (ECR → image push → full apply).
- Wire GitHub OIDC: set `AWS_DEPLOY_ROLE_ARN` in the staging environment.
- Verify end-to-end: `git push origin main` → CI → staging deploy → public `*.cloudfront.net` URL.
- See [`infra/README.md`](./infra/README.md) for step-by-step.

### Domain + TLS
- Pick subdomain (e.g. `sdp-browser.rmbl.org`, `api.sdp-browser.rmbl.org`).
- Provision ACM cert in us-east-1, add to `terraform.tfvars`, apply, wire Route53.

### COG audit (SPEC Phase 0)
- Build `tools/cog-audit/` CLI that runs `rio cogeo validate` + `gdalinfo -json` across the full S3 catalog.
- Fix overviews, block sizes, compression on any non-compliant COGs.
- Target: median cold-tile latency under 1.0 s.

---

## Medium-term

### One-click "Open in JupyterHub"
Build on the current .ipynb download to offer a single-click handoff into `rmblcomputehub.org`:

1. **Install nbgitpuller** in the CHESS Hub user image (`pip install nbgitpuller`).
2. **Template notebook repo** (`rmbl-sdp/sdp-notebooks`) with a parameterized "SDP Explorer" notebook that reads `catalog_id`, `bbox`, and `year` from a sidecar `params.json` or environment variables.
3. **SDP Browser button** constructs an nbgitpuller URL:
   ```
   https://rmblcomputehub.org/hub/user-redirect/git-pull
     ?repo=https://github.com/rmbl-sdp/sdp-notebooks
     &urlpath=lab/tree/sdp-notebooks/explore.ipynb
     &branch=main
   ```
4. **Parameter passing**: write a pre-spawn hook or a lightweight JupyterHub service that injects query-string params into the user's session as a `params.json` file. Alternatively, use the JupyterHub Contents API with a server-side proxy to upload the generated notebook directly.
5. **Fallback**: the .ipynb / .Rmd download buttons remain for users without Hub accounts.

### Arbitrary-polygon AOI
- Replace the bbox-only drag rectangle with [Terra Draw](https://github.com/JamesLMilner/terra-draw) for polygon, circle, and freeform AOIs.
- Upload GeoJSON / KML / zipped shapefile as AOI.
- Switch TiTiler extraction from `/cog/bbox/…` to `POST /cog/feature` with the GeoJSON geometry.
- Update R / Python snippet generators to use the polygon geometry instead of a bbox.

### STAC API + dynamic mosaics (SPEC Phase 3)
- Deploy `stac-fastapi` + `pgstac` on Fargate.
- Swap the client-side STAC walker for server-side CQL2 search (the `CatalogRepo` interface is already designed for this — implement a `pgstac` backend and drop it in).
- Wire `titiler-pgstac` for dynamic mosaics (e.g. "latest NDVI over East River", "median 2018–2024 snow-cover").

### Async extraction jobs (SPEC Phase 3)
- SQS + Fargate Spot workers for large polygon × time-series extractions.
- `POST /extract` → job queue → worker → output to S3 → pre-signed URL.
- Jobs panel in the UI with status, progress, and download link.

### Icechunk / Zarr-backed array datasets
The CHESS Analysis Hub hosts large multi-dimensional datasets (e.g. NEON AOP hyperspectral imagery — 426 bands, ~1,700 tiles across 4 domains/years) that don't fit the COG-per-layer model. These are stored as NetCDF on S3 (`s3://rmbl-chess-data/AOP/spectrometer/mosaic/`) and accessed via [VirtualiZarr](https://github.com/zarr-developers/VirtualiZarr) + [Icechunk](https://github.com/earth-mover/icechunk) virtual stores at `s3://rmbl-chess-data/virtual/AOP/spectrometer/{domain}/{year}/`. A separate STAC catalog (`s3://rmbl-chess-data/stac/catalog.json`, ~1,742 items) indexes the individual tiles.

Integration path:
1. **Multi-catalog discovery** — extend `CatalogRepo` to walk multiple STAC roots (the SDP COG catalog + the CHESS AOP catalog). The UI groups results by source and flags the dataset format (COG vs. Zarr/Icechunk).
2. **Zarr-aware tile server** — TiTiler can't render Zarr natively. Options: [titiler-xarray](https://github.com/developmentseed/titiler-xarray) for xarray-backed datasets, or [Xpublish](https://github.com/xpublish-community/xpublish) with a tile-serving plugin. Either runs as a second Fargate service behind the same CloudFront distribution.
3. **Band/wavelength selection UI** — 426-band data needs a wavelength picker (not just a band-index dropdown). Could expose a spectral-profile viewer (click a pixel → plot reflectance vs. wavelength) alongside the existing histogram panel.
4. **Generated notebooks** — for Icechunk datasets, the .ipynb generator would emit `xr.open_zarr(icechunk_store_url)` instead of `pysdp.open_raster()`, with `sel(wavelength=...)` for band subsetting.
5. **Performance** — Icechunk virtual stores support lazy chunk reads; the tile server reads only the chunks intersecting the requested tile, so latency is comparable to COG range reads if the store is well-chunked.

Prerequisite: confirm the AOP STAC catalog is stable and the virtual stores are fully rebuilt after the 2026-03 S3 path migration.

---

## Long-term / aspirational

### pysdp CLI
- `pysdp open R3D009 --bbox -107,38.7,-106.8,38.9 --year 2020` → opens an interactive session or writes a notebook.
- Enables terminal-based workflows and CI pipelines that pull SDP data.

### Shared state via URL
- The SDP Browser's URL hash already encodes the full session (layers, view, AOI, discovery filters).
- A future "Open in Hub" button could pass that URL to a notebook that fetches the hash and reconstructs the session programmatically.

### Monitoring + analytics
- CloudFront real-time logs → Athena + QuickSight for tile hit-rate, unique visitors, top datasets.
- PostHog or Plausible for frontend product analytics (privacy-respecting).
- CloudWatch alarms on TiTiler 5xx rate, Fargate task failures, SQS DLQ depth.

### Pre-rendered hero tiles
- For the ~20 most-viewed layers, pre-generate z5–z14 tiles and serve from S3 behind CloudFront — bypasses TiTiler entirely for the most popular data.

### Accessibility + i18n
- WCAG 2.1 AA audit.
- Structure UI strings for future Spanish translation.

### Docs site
- MkDocs or Starlight covering user guide, recipe gallery, REST/STAC API reference.
- Cross-link rSDP and pysdp docs.
