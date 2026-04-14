# SDP Browser — Prototype

Minimal local stack to iterate on the SDP Browser interface **before** committing to the full web infrastructure.

- **TiTiler** (FastAPI + rio-tiler) in Docker, reading SDP COGs anonymously from the public `rmbl-sdp` S3 bucket in `us-east-2`.
- **MapLibre GL JS** single-page UI served by an nginx sidecar container.
- A **toy catalog** (`catalog.json`) of three hand-picked items — one DEM, one continuous derived layer, and one RGB NAIP scene.

Expect tiles to be noticeably slower than they will be in production: there is no CloudFront CDN, no S3 VPC endpoint, and your laptop is (probably) not in `us-east-2`. The goal is to validate the **interface**, not the latency.

## Run it

```bash
cd prototype
docker compose up --build
```

Then open <http://localhost:8080>.

TiTiler is at <http://localhost:8000> — the auto-generated API docs live at <http://localhost:8000/docs>.

## What's in the UI today

- Layer picker with three items from the toy catalog.
- Server-side **colormap** + **rescale** controls (single-band layers) with a live legend.
- **AOI statistics**: click *Arm AOI draw*, then shift-drag a rectangle on the map. The app POSTs the polygon to `/cog/statistics` and renders the JSON result.
- Shareable URL hash (`#layer=…&cmap=…&rescale=…`).

## What is intentionally **not** here yet

- STAC-catalog walking (prototype uses a static `catalog.json`).
- Time-series navigation.
- Vector overlays from ArcGIS Online.
- Clipped raster downloads and recipe export.
- Auth, rate limiting, or WAF.
- CloudFront caching — every tile hits TiTiler, every TiTiler call hits S3.

These are Phase 1–3 in `../SPEC.md`. The goal of this prototype is to poke at the interface and decide what actually matters before we invest.

## Editing the catalog

`web/catalog.json` is served directly by nginx (the `web/` dir is bind-mounted into the container). Edit the file and refresh the browser; no rebuild needed.

Schema:

```json
{
  "id": "unique-id",
  "title": "Human-readable",
  "description": "Short blurb",
  "cog_url": "https://rmbl-sdp.s3.us-east-2.amazonaws.com/…/thing.tif",
  "bbox": [minLon, minLat, maxLon, maxLat],
  "kind": "singleband" | "rgb",
  "default_colormap": "viridis",      // singleband only
  "default_rescale": "0,1",           // "min,max"
  "bidx": [1, 2, 3],                  // rgb only
  "units": "m"
}
```

## Troubleshooting

- **Blank tiles / 500s:** check `docker compose logs titiler`. Most common cause is the target COG not being a valid COG, or rescale ranges that don't match the data's actual range — open `http://localhost:8000/cog/statistics?url=…` to see real min/max.
- **Slow first tile:** TiTiler is cold and GDAL is filling caches from S3. Pan/zoom for ~20 s and it settles.
- **CORS errors in the browser:** the prototype TiTiler allows `*`. If you run the web UI from a port other than 8080, it should still work; if not, check the `CORSMiddleware` config in `titiler/app.py`.
- **AOI stats returning empty:** confirm your drawn rectangle actually overlaps the layer's `bbox`.

## Next steps once the interface feels right

Likely changes that will bubble into `../SPEC.md`:

1. Replace the toy catalog with a lazy walk of the real STAC catalog.
2. Swap the DIY AOI rectangle for Terra Draw (polygons, uploaded GeoJSON, edit handles).
3. Add a time dimension for `R4D*`-style daily/yearly time-series.
4. Add a "Recipe" panel that mirrors each action as an rSDP R snippet.
