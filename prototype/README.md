# SDP Browser — Prototype

A local, Docker-composed stack to iterate on the SDP Browser interface **before** committing to the full cloud deployment described in `../SPEC.md`. The goal is to validate the user experience against real SDP data, not to demonstrate production latency or scale.

## Relationship to the rest of the repo

- **This directory** (`prototype/`) is the sandbox. Break things freely; ship when the feature feels right.
- [`../app/web/`](../app/) is the **production frontend** — today a verbatim copy of `prototype/web/` with a runtime config shim. Changes here get promoted there by hand until we unify.
- [`../services/titiler/`](../services/) is the **production Dockerfile** for the tile server, mirroring `prototype/titiler/` but with `CORS_ORIGINS` as a runtime env var.
- [`../infra/`](../infra/) is the **Terraform** for the AWS deployment; `prototype/` never talks to that.
- [`../SPEC.md`](../SPEC.md) is the architecture blueprint.

The stack is two containers:

- **TiTiler** (FastAPI + `rio-tiler`) — dynamic COG tile server that reads SDP COGs anonymously from `s3://rmbl-sdp` in `us-east-2`. Exposes `/cog/tiles/…`, `/cog/info`, `/cog/statistics`, `/cog/bbox/…`, etc.
- **nginx** — serves the static single-page app in `web/` (MapLibre GL JS + ES modules). No build step.

The frontend talks to the live RMBL SDP STAC catalog (`https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json`) for discovery, and to the public ArcGIS Online *ResearchSites_2026_Public_View* FeatureServer for site overlays.

## Quick start

```bash
cd prototype
docker compose up --build
```

Open <http://localhost:8080>.

- **TiTiler** lives at <http://localhost:8000>, auto-docs at <http://localhost:8000/docs>.
- Bring the stack down with `docker compose down`.
- `web/` is bind-mounted, so edits to HTML/CSS/JS appear on browser refresh — no rebuild. `titiler/` changes require `docker compose up --build titiler`.

Expect the first tile of each layer to take 1–10 s: TiTiler is cold, GDAL is filling its caches, and S3 range reads from your laptop to `us-east-2` aren't as cheap as they'd be from Fargate in the same region. Subsequent tiles at similar zoom are much faster — this is what the production CloudFront cache plus same-region worker is there to hide.

## Features

### Catalog discovery
- On first load, the app walks the static STAC catalog with a bounded-concurrency BFS (10 in flight), builds an `ItemDescriptor` per collection, and caches the index in IndexedDB (`sdp-browser/kv/catalog-index-v1`) keyed by the root catalog's ETag (or a SHA-256 of its body as a fallback). A second load is essentially instantaneous.
- A **🔍 Discover layers** button opens a full-screen drawer over the map with:
  - Free-text search over title / description / id / rmbl:catalog_id.
  - Live facets: **Domain / Release / Type / Resolution / Bands** with counts that recompute as you narrow.
  - A results grid of card-style entries and an item-detail panel with full metadata, an **Add to Map** button, and an **Open in STAC Browser ↗** link.
  - ESC / the **Close** button / clicking the add button returns you to the map.
- A **refresh** link next to the catalog status clears the cache and re-walks on demand.

### Active layers
- Each added layer becomes a row in the sidebar's Active list, rendered via TiTiler as a MapLibre raster source.
- Per-row controls: visibility toggle, ▼ expand to a per-layer styling body, ✕ remove, and a ⋮⋮ drag grip. Rows can be reordered by drag-and-drop; the map stack updates accordingly.
- A **floating legend** at mid-right on the map stacks per-layer gradient bars for all visible single-band and timeseries layers.

### Per-layer styling (inside the expanded row)
- **Band selection** (multiband only): switch between RGB composite (picks R / G / B bands individually) and Single-band with a colormap.
- **Colormap picker** with gradient-preview options: `viridis`, `magma`, `inferno`, `cividis`, `terrain`, `rdbu`, `rdbu_r`, `spectral`, `greys`, `ylgnbu`.
- **Rescale** input (`min,max`) with an **auto** button that hits `GET /cog/statistics?…&p=2&p=98&max_size=1024` and applies the 2nd–98th percentile as a clean default stretch. Auto results are cached per item so scrubbing years or re-adding layers doesn't re-hit the endpoint.
- **Opacity** slider (live).
- **Time-series** scrubber for collections with multi-year items (e.g. snow duration 1993–2022). Slider + prev/next buttons swap the COG URL; the year is part of the sharable hash.

### AOI extraction
- **Draw an Area of Interest** then drag on the map to define a bbox AOI.
- **AOI summaries**: per-band `/cog/statistics` with min/max/mean/median/std/count/valid_percent and a histogram where bar colours are sampled from the active colormap (for single-band) or R/G/B (for multiband RGB).
- **Subset downloads**:
  - **GeoTIFF (native)** — `/cog/bbox/…tif` clips the COG in its native CRS and dtype; downloaded as `<cog-basename>_AOI_subset.tif`.
  - **PNG (styled)** — bbox clip with colormap + rescale applied.
  - **Copy Subset R Code** — generates an `rSDP` snippet using the item's `rmbl:catalog_id`, preserving time-series `years =` where applicable.
- **Use bounding box as AOI** on the popup of any research-site feature — supports multipart polygons (uses the part that contains the click).

### Map overlays
- **Labels & roads** — Esri World_Transportation + World_Boundaries_and_Places stacked above data layers.
- **Research sites** — RMBL ArcGIS Online classic FeatureServer (layer 14); click a polygon to pop a dark-themed attribute panel plus the Use-as-AOI button.
- **My research sites** *(authenticated)* — same layout but pulled from the non-public `ResearchSites_2026/FeatureServer/14` after the user signs in to ArcGIS Online via OAuth 2.0 (PKCE). A **Researcher** dropdown appears once signed in; selecting a value applies a server-side `where=Researcher='…'` filter. Drawn in cyan with a dashed outline so it's distinguishable from the public overlay when both are visible at once. See [§AGOL OAuth setup](#agol-oauth-setup) for one-time app registration.

### URL hash
Everything worth sharing survives a reload:

- `layers=` — active layer stack (catalog id, colormap, rescale, opacity, visibility, year, expanded flag).
- `view=<lat>,<lng>,<zoom>` — current map centre and zoom (throttled to `moveend`).
- `discover=1&dq=<search>&df=domain:UG,UER|type:Snow` — open discovery drawer with search + facets pre-applied.

### Sidebar chrome
- **Collapsible** sidebar with a toggle straddling the seam; state persisted in `localStorage` as `sdp-sidebar-collapsed`.
- **Resizable** (220–600 px) by dragging the right edge; width persisted as `sdp-sidebar-w`.

## File layout

```
prototype/
├── README.md             ← you are here
├── docker-compose.yml    ← titiler + web (nginx) services
├── titiler/              ← Python tile server
│   ├── Dockerfile        ← python:3.12-slim + libexpat1, non-root, healthcheck
│   ├── requirements.txt  ← titiler.core + uvicorn pins
│   └── app.py            ← GDAL env, CORS, /cog router, /health
└── web/                  ← served by nginx at port 8080
    ├── index.html        ← UI shell (DOM + CSS + inline script)
    ├── catalog.json      ← fallback toy catalog, used only if STAC walk fails
    └── js/
        ├── idb.js            ← minimal Promise-based IndexedDB wrapper
        └── catalog-static.js ← STAC walker, ItemDescriptor builder,
                                facet aggregator, CatalogRepo interface
```

`catalog-static.js` exposes a repo-like object (`all()`, `get(id)`, `search({q, selected, yearRange})`, `facets`) that the UI consumes generically. A future Phase 3 swap to `stac-fastapi` + `pgstac` is a drop-in: the same interface with a remote `/search` implementation.

## Configuration

- **STAC root**: hard-coded in `web/index.html` as `STAC_ROOT`. Point at any STAC catalog that exposes the same `rmbl:*` collection summaries, or at `web/catalog.json` (relative) to always use the toy catalog. (The production app at `../app/web/` instead reads this from a runtime `config.js`; the prototype keeps things hardcoded on purpose.)
- **TiTiler endpoint**: `TITILER` constant in `web/index.html`, defaults to `http://localhost:8000`.
- **Fallback catalog schema** (`web/catalog.json`):

  ```jsonc
  {
    "items": [
      {
        "id": "unique-id",
        "rsdp_id": "R3D009",                 // rmbl:catalog_id equivalent
        "title": "Human-readable",
        "description": "Short blurb",
        "bbox": [minLon, minLat, maxLon, maxLat],
        "kind": "singleband" | "multiband" | "rgb" | "timeseries",

        // singleband / multiband / rgb
        "cog_url": "https://…/thing.tif",

        // multiband only
        "bands": [{ "idx": 1, "name": "Red" }, …],
        "default_mode": "rgb" | "single",
        "default_bidx": [1, 2, 3],

        // timeseries only
        "url_template": "https://…/foo_{year}_…tif",
        "years": [1993, 1994, …, 2022],
        "default_year": 2020,

        // common
        "default_colormap": "viridis",
        "default_rescale": "0,1",
        "units": "m"
      }
    ]
  }
  ```

- **`AWS_NO_SIGN_REQUEST=YES`** is set in `titiler/app.py`, so TiTiler reads `s3://rmbl-sdp` anonymously. For a private bucket, supply AWS credentials via the container environment and flip that off.

### AGOL OAuth setup

The "My research sites" overlay needs an ArcGIS Online application registered as a **Browser** app type. One-time setup:

1. AGOL → **Content → New item → Application → Other application**.
2. Open the item → **Settings → App Registration → Register app**.
3. Set **App type: Browser**. (No client secret; PKCE is required for browser apps.)
4. Add redirect URIs — exact match, including scheme + port + path:
   - `http://localhost:8080/oauth-callback.html` (prototype + local app testing)
   - `https://sdpbrowser.org/oauth-callback.html` (staging)
   - *(prod domain when stood up)*
5. Copy the **Client ID** and update:
   - `prototype/web/index.html` → `AGOL_CLIENT_ID` constant (default for the prototype).
   - `app/web/config.js` → `AGOL_CLIENT_ID` key (runtime override for the deployed app; `scripts/deploy-staging.sh` writes this from the `AGOL_CLIENT_ID` shell variable at the top).

The frontend talks directly to `https://www.arcgis.com/sharing/rest/oauth2/{authorize,token}`; nothing on our side stores credentials. Tokens live in `sessionStorage` under `sdp_agol_token` and expire after AGOL's default (~2 h); when one expires the user just clicks **Sign in with ArcGIS** again.

If you change the FeatureServer used for the authenticated overlay, update both `AGOL_PRIVATE_SITES_URL` and `AGOL_RESEARCHER_FIELD` (currently `Researcher`) in the same three places.

## Troubleshooting

- **"Loading catalog…" never finishes.** Open devtools → Console. The walker logs `collection fetch failed: <url>` and `items failed in <url>` for any node it couldn't read. Fast-fail timeouts are 15 s per fetch. A partial walk still produces a usable catalog; the status line shows the final count.
- **Some items are in the catalog but missing after a re-walk.** Most often (a) the collection's `data` asset points at a non-COG file, or (b) a 403 / 404 on the S3 path. Prior to the `v1` catalog cutover some items were serialized with bare `NaN` / `Infinity` tokens (not valid JSON) and that was the dominant cause; the walker no longer sanitises those, so any such regression will show up as `Unexpected token 'N'` parse errors in the console.
- **Layers visualize as a flat colour.** The default stretch was off. Click the **auto** button next to Rescale to recompute from a 2nd–98th percentile of the COG.
- **Research sites toggle shows `error`.** The ArcGIS Online item probably lost its public-sharing setting or the FeatureServer layer id changed. `SITES_QUERY_URL` in `web/index.html` hard-codes layer `14`.
- **"Sign in with ArcGIS" pops up then immediately closes / shows "redirect_uri" error.** The redirect URI in the AGOL app registration must be an exact string match for `<origin>/oauth-callback.html`, including scheme + port. Localhost dev needs `http://localhost:8080/oauth-callback.html` registered.
- **"Popup blocked".** Browser blocked the OAuth popup. Allow popups for the site and click sign-in again.
- **"My research sites" loads then shows `error`.** Almost always token expiry mid-session — the handler clears the stored token and reverts to the signed-out UI; click sign-in again. If it persists, check the browser console for an HTTP 498/499 (token) or schema error (`Researcher` field renamed).
- **Blank tiles / 500s from TiTiler.** Check `docker compose logs titiler`. Most common cause is a COG with no valid overviews; `rio cogeo validate <url>` in a local Python env will tell you.
- **CORS errors** fetching the STAC or ArcGIS endpoints. Both are public today. If this regresses, the fix is a server-side proxy; we don't want to ship tokens into the client.

## Roadmap (this prototype → production)

Tracking against `../SPEC.md`:

- ✅ **Deployment scaffolding** — Terraform modules, bootstrap, envs, and CI workflows exist in `../infra/` and `../.github/workflows/`. First `terraform apply` is pending an AWS account + domain decision.
- ➖ `stac-fastapi` + `pgstac` for server-side CQL2 search and dynamic mosaics (`titiler-pgstac`). Not needed at current catalog size; client-side STAC walk handles it.
- ➖ Async extraction jobs for AOIs larger than a single tile fits.
- ➖ Arbitrary-polygon AOI (Terra Draw) instead of bbox-only rectangles.
- ➖ Thumbnails / footprints in the discovery drawer (SDP STAC items don't have them yet — upstream fix).
