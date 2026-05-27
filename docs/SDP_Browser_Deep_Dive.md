# A Deep Dive into the SDP Browser

*A guide for the RMBL research community to the Spatial Data Platform and its new browser-based front door — and how it connects to the `rSDP` and `pySDP` analysis packages.*

---

## Why this document

If you work on environmental science around the Upper Gunnison Basin, you have almost certainly bumped into the problem the Spatial Data Platform (SDP) was built to solve: the data you need exists, somewhere, in some format, on someone's hard drive or in a folder structure only its creator understands. A 3-meter digital elevation model, fifteen years of daily temperature surfaces, weekly drone orthomosaics of the Gothic townsite, snow-cover-duration rasters, land-cover classifications — these are foundational inputs for a huge range of RMBL research, and historically each one was a small expedition to track down, download, reproject, and load.

The SDP collected those products into one curated, cloud-hosted, openly accessible catalog. The `rSDP` (R) and `pySDP` (Python) packages then made that catalog *programmable*: a few lines of code instead of an afternoon of file wrangling. The **SDP Browser** is the third piece — a no-code, point-and-click way to discover, preview, and extract from the same catalog directly in your web browser, with no installation and no programming required.

This deep dive covers three things: what the Spatial Data Platform actually is and why it's built the way it is; what the SDP Browser lets you do and what makes it genuinely new; and how the browser and the `rSDP`/`pySDP` packages are designed to work together rather than compete. The throughline is a single idea worth stating up front: **the browser is where you explore and decide; the packages are where you reproduce and scale — and the browser writes the code that gets you from one to the other.**

---

## Part 1 — Background: the Spatial Data Platform

### What it is

The Spatial Data Platform is RMBL's curated catalog of geospatial data products covering the research areas of western Colorado — the Upper Gunnison Basin, the Upper East River, the Gothic townsite, and the broader GMUG (Grand Mesa, Uncompahgre, and Gunnison National Forests) region. The catalog spans elevation and terrain derivatives, imagery and orthomosaics, climate and radiation surfaces, snow products, hydrology, vegetation and land cover, and a range of supplementary and planning layers. Today it holds on the order of 160 data collections, and it grows as new products are processed and released.

Every product is hosted in the cloud on Amazon S3 (the `rmbl-sdp` bucket, in AWS's `us-east-2` region) and is **openly readable** — no account, no credentials, no request forms. The data is the same whether you reach it through the browser, through `rSDP`/`pySDP`, through QGIS, or through raw GDAL. There is one canonical copy, and everything points at it.

### Two technical choices that make it work

The SDP rests on two open-standard decisions that are worth understanding, because they shape everything the browser and the packages can do.

**Cloud-Optimized GeoTIFFs (COGs).** Every raster in the SDP is a COG. A COG is an ordinary GeoTIFF organized internally so that a client can read *just the part it needs* over the network — a single map tile, a small window around your field site, or a low-resolution overview for a thumbnail — without downloading the whole file. The file carries internal tiling and a pyramid of pre-computed overviews, and it advertises a layout that lets software issue precise HTTP "range" requests for specific byte ranges. The practical upshot: a 4-gigabyte statewide raster can render on your screen, or be sampled at three field sites, by transferring a few hundred kilobytes. This is what makes "the data stays on S3 and you read what you need" a realistic workflow rather than a slogan.

**A STAC catalog.** The products are described by a SpatioTemporal Asset Catalog (STAC) — a widely adopted open standard (the SDP uses STAC 1.1.0) for cataloging geospatial assets. The catalog lives alongside the data at `s3://rmbl-sdp/stac/v1/catalog.json` and is organized into sub-catalogs for the major domains. Each entry records the things you need to reason about a product before you touch the pixels: its spatial footprint, its coordinate reference system, its temporal extent, its bands and their data types, scale and offset factors, nodata values, and provenance. STAC is what lets the browser and the packages share *exactly the same* understanding of the catalog — and it's why the browser can be a thin, fast client over a static set of JSON files rather than a heavyweight database application.

### The vocabulary you'll see everywhere

A few conventions recur across the SDP, the browser, and the packages, and knowing them makes everything else legible:

- **Catalog IDs.** Each product has a short six-character code — `R3D009` (a 3 m DEM), `R3D012` (slope), `R3D018` (land cover), `BM012` (a basemap product), `R4D004` (daily maximum temperature). The leading character group encodes the release, the middle encodes the domain hierarchy, and the trailing digits are a product sequence. These IDs are the lingua franca: the same `R3D009` you click in the browser is the `R3D009` you pass to `sdp_get_raster()` or `pysdp.open_raster()`.

- **The canonical CRS: `EPSG:32613`.** Almost every SDP raster is in UTM Zone 13N. Both packages default to it and will reproject your points and polygons into it automatically; the browser serves map tiles in Web Mercator for display but preserves the native projection for any data you extract or download. Either way, you rarely have to think about projections — but when you do, this is the number.

- **Time-series structure.** Products are classified by how they vary in time: `Single` (one snapshot), `Yearly`, `Monthly`, `Daily`, `Seasonal`, and `Weekly`. This classification drives how data is sliced — and it's why the browser shows a date control for a daily temperature product but not for a static DEM, and why `open_raster("R4D004", date_start=..., date_end=...)` knows what a date range means for that product.

- **Deprecation and provenance.** Products are versioned. When a dataset is superseded, it's flagged as deprecated and points at its replacement, so old analyses remain traceable while new work uses current data. The catalog also tracks known data-quality issues per product.

Everything from here on builds on these foundations. The SDP Browser is, at heart, a friendly window onto this STAC catalog and these COGs.

---

## Part 2 — The SDP Browser: what it does

The SDP Browser is a web application — you open it at **[sdpbrowser.org](https://sdpbrowser.org)** and start working. There is nothing to install, no environment to set up, and no programming required. It is built to be the fastest possible path from "I wonder what data exists for my site" to "I'm looking at it on a map" to "I have the data, or the code to get it." That path has four movements: **discover, visualize, extract, and share.**

### Discover

The discovery drawer is a faceted search over the entire catalog. You can type a free-text query, and you can filter by **domain**, **release**, **product type** (Imagery, Topo, Hydro, Climate, Radiation, Snow, Vegetation, Mask, Planning, Supplemental), **spatial resolution**, and **band count**. Results can be grouped by type so related products cluster together, or flipped into a sortable **table view** when you want to scan resolutions, dates, and band counts across many products at once.

Crucially, discovery surfaces the *metadata that helps you choose*, not just names. Each result carries its description, footprint, resolution, temporal extent, and data lineage. Deprecated products are visibly flagged — so you won't accidentally build new work on a superseded layer — and each product detail pane includes a **"Report an issue"** link that routes straight to the SDP's issue tracker, closing the loop between the scientists using the data and the people maintaining it. Discovery is deliberately rich because choosing the right product is often the hardest part of a geospatial workflow, and it's the part a bare file listing does nothing to help with.

### Visualize

Pick a layer and it renders on an interactive map (built on MapLibre, over a desaturated Esri World Imagery basemap with optional transportation and boundary reference overlays). This is where the browser earns its keep, because *seeing* a raster well is not trivial, and the browser does a surprising amount of work to make the default view a good one.

- **Smart contrast stretching.** Raw scientific rasters rarely look like anything useful with a naive 0–255 stretch. The browser samples the data and auto-fits the display range to the 2nd–98th percentile of actual values, excluding nodata so that undeclared fill values (a stray `-9999`) don't wash everything out. You see a well-contrasted image on first load, and you can override the range by hand whenever you want.

- **Physical-unit awareness.** Many products store data in scaled integers — a multispectral orthomosaic might store reflectance as 16-bit integers with a scale factor of 0.0001, so a "real" reflectance of 0.3 lives as the value 3000 in the file. The browser reads the scale and offset from the catalog and lets you work in *physical* units (reflectance, degrees, meters) while it handles the conversion to and from the stored values behind the scenes.

- **Scientific colormaps.** A curated set of colormaps is available — `viridis`, `cividis`, `magma`, `inferno`, `turbo`, `spectral`, `RdBu`, `terrain`, `greys`, and more — with color-vision-deficiency-friendly options (`viridis`, `cividis`) as the defaults. Any ramp can be inverted with a single toggle.

- **True-color and false-color band math.** For multi-band products the browser lets you choose which bands map to red, green, and blue. Multispectral imagery defaults to a sensible natural-color combination, and false-color presets (for example, mapping near-infrared to red to highlight vegetation) are a click away. Single-band products render through a colormap; multi-band products render as RGB composites — and you can switch between the two interpretations.

- **Time and animation.** For time-series products you get a date navigator, and — distinctively — a built-in **animation panel** that plays the series as a loop. Tiles are cached as they load so playback is smooth, which makes the browser usable as a kiosk or presentation display: set a snow-duration or phenology series running on a screen and let it loop. Adjacent dates are prefetched so scrubbing through time stays responsive.

Layers stack with adjustable opacity and ordering, so you can drape a vegetation classification over a hillshade, or compare two releases of the same product.

### Extract

Visualization answers "what does this look like?" Extraction answers "what are the numbers, here?" Draw an area of interest on the map — a rectangle or polygon around your study site — and the browser turns it into data:

- **Zonal statistics.** For the drawn AOI, the browser computes per-band summary statistics — minimum, mean, median, maximum, standard deviation — along with a histogram of the value distribution. This runs server-side against the COG, so it works on large rasters without downloading them.

- **Clipped downloads.** Export the AOI as a clipped GeoTIFF (preserving the native projection and data values) or as a PNG snapshot for figures and slides.

These extraction tools cover the common "I need numbers for my plots" and "I need a small raster for my own analysis" cases entirely within the browser, with no code at all.

### Share

Everything you set up — which layers are loaded, their styling, the colormap and contrast range, the selected date, the map view, even your discovery filters — is encoded into the page's URL as you work. That means **the URL *is* the state**: copy it, paste it into an email or a paper or a lab wiki, and whoever opens it lands on exactly the view you built. There are also deep links that let other tools (or the `rSDP`/`pySDP` documentation) point directly into a specific map view of a specific product. A figure caption can carry a live link to the data behind it.

This shareability is quietly one of the most important features for a *research community*, because it turns "here's a dataset" into "here's this dataset, styled this way, at this place and time, that you can open and verify yourself in one click."

---

## Part 3 — What's new and cool (a look under the hood)

You can use the browser without knowing any of this, but a few design choices are worth surfacing because they explain why it feels fast and why it scales to a community of users — and because they reflect deliberate, RMBL-specific engineering decisions.

**It reads the data live, not a pre-baked copy.** There is no separate "browser dataset." The browser renders the *same* COGs on S3 that the packages read and that the SDP publishes. Map tiles are generated on demand by a dynamic tile server (TiTiler, built on `rio-tiler` and GDAL) that issues precise range requests into the COGs and reprojects them to the web map on the fly. Because the tile server runs as a persistent, always-warm service rather than spinning up cold for each request, its caches and connection pools stay hot — which is exactly why panning and zooming feel immediate. (This persistent-service choice was made deliberately: cold-start serverless functions are a poor fit for tile workloads, where warm GDAL caches and pooled HTTP/2 connections to S3 are what make the difference.)

**Caching all the way down.** Rendered tiles are cached at a global content-delivery layer (CloudFront) keyed on the full set of display parameters, so the second person to view a popular layer — or you, the second time you pan back — gets tiles served from an edge cache rather than re-rendered. During a workshop where thirty people load the same snow product, almost everyone after the first is served from cache. The whole stack lives in the same AWS region as the data, with a direct private path to S3, which keeps both latency and cost down — a real consideration for a small organization.

**It's honest about what the catalog says.** The browser walks the STAC catalog directly in your browser and caches it locally (in your browser's IndexedDB) so repeat visits are fast. When a product's STAC metadata under-reports something — say, a file is genuinely multi-band but its record only describes one band — the browser probes the actual file and reconciles the difference before rendering, so you see the product as it really is rather than as a stale record describes it. The recent fix that prompted part of this work was exactly in this spirit: ensuring that scale factors are known *before* the first tile renders, so scaled-integer products (like the multispectral orthomosaics) display correctly the instant you open a shared link, rather than washing out to white.

**No build step, no framework lock-in.** The front end is deliberately simple — a single-page application of vanilla HTML, CSS, and JavaScript, served as static files. That keeps it cheap to host, fast to load, and easy to maintain, which matters for a tool that needs to live for years with light-touch upkeep.

The common thread is that the browser is engineered to be *a faithful, fast view of the canonical data* — not a separate silo. That faithfulness is what makes the next part possible.

---

## Part 4 — How the browser relates to `rSDP` and `pySDP`

The browser is wonderful for exploration and for one-off extractions. But real research is reproducible, scriptable, and often operates at scales no point-and-click tool should attempt — hundreds of field sites, decades of daily layers, batch processing across products. That's the domain of the two analysis packages, and the SDP Browser is explicitly designed to *hand off* to them rather than replace them.

### The two packages in brief

**`rSDP`** is the R package (docs at **[rmbl-sdp.github.io/rSDP](https://rmbl-sdp.github.io/rSDP/)**). It gives R users a simple interface to discover, query, and subset SDP products as `terra` `SpatRaster` objects, reading lazily from the cloud via GDAL's VSICURL so you don't download whole files. Its core verbs:

- `sdp_get_catalog()` — discover and filter products (by domain, type, release, time-series type, deprecation status).
- `sdp_get_metadata()` — fetch detailed metadata for a product.
- `sdp_get_raster()` — open a product (or a time slice of one) as a `SpatRaster`.
- `sdp_extract_data()` — sample values at points, or compute per-polygon summary statistics, auto-reprojecting your locations to the raster's CRS.
- `sdp_get_dates()`, `sdp_browse()`, `download_data()`, `sdp_report_issue()` — discover available dates, render an interactive product grid, bulk-download COGs, and report data issues.

**`pySDP`** is the Python package (docs at **[rmbl-sdp.github.io/pySDP](https://rmbl-sdp.github.io/pySDP/)**), a behavior-matched port of `rSDP` that returns native PyData types — `xarray.Dataset` for rasters, `geopandas.GeoDataFrame` for extractions — with optional Dask chunking for large stacks. Its verbs mirror `rSDP` almost one-to-one:

| `rSDP` (R) | `pySDP` (Python) | Returns |
|---|---|---|
| `sdp_get_catalog()` | `get_catalog()` | data frame |
| `sdp_get_metadata()` | `get_metadata()` | metadata |
| `sdp_get_raster()` | `open_raster()` / `open_stack()` | `SpatRaster` / `xarray.Dataset` |
| `sdp_extract_data()` (points) | `extract_points()` | `GeoDataFrame` |
| `sdp_extract_data()` (polygons) | `extract_polygons()` | `GeoDataFrame` |
| `sdp_get_dates()` | `get_dates()` | dates |
| `sdp_browse()` | `browse()` | interactive grid |
| `download_data()` | `download()` | files + status |

Both packages share the catalog ID scheme, the `EPSG:32613` default, the time-series vocabulary, and the same scale/offset and deprecation semantics. If you can do something in one, the other has a near-identical call. This parity is maintained on purpose — the two packages are kept behaviorally aligned function by function — so a lab that mixes R and Python users isn't split into two incompatible workflows.

### The bridge: the recipe generator

Here is the feature that ties the whole ecosystem together. **Whenever you draw an AOI in the browser, it generates ready-to-run code that reproduces what you just did — in both R and Python.** This is the reproducibility bridge: you explore visually, find the product and area you want, and the browser hands you a snippet you can paste into RStudio or a Jupyter notebook to get the same data programmatically.

For an R user, the browser emits an `rSDP` recipe like:

```r
# devtools::install_github('rmbl-sdp/rSDP')
library(rSDP)
library(terra)

# 3m Digital Elevation Model (DEM)
metadata <- sdp_get_metadata("R3D009")
dataset  <- sdp_get_raster("R3D009")

# AOI bbox drawn in the SDP Browser (WGS84 lon/lat).
aoi <- vect(ext(-107.020000, -106.980000, 38.950000, 38.975000),
            crs = "EPSG:4326")
aoi <- project(aoi, crs(dataset))

# Crop to AOI and save.
subset <- crop(dataset, aoi)
writeRaster(subset, "R3D009_AOI_subset.tif", overwrite = TRUE)
```

For a Python user, the equivalent `pySDP` recipe:

```python
# pip install pysdp
import pysdp

# 3m Digital Elevation Model (DEM)
metadata = pysdp.get_metadata("R3D009")
dataset  = pysdp.open_raster("R3D009")

# AOI bbox drawn in the SDP Browser (WGS84 lon/lat).
subset = dataset.rio.clip_box(
    minx=-107.020000, miny=38.950000,
    maxx=-106.980000, maxy=38.975000,
    crs="EPSG:4326",
)
subset.rio.to_raster("R3D009_AOI_subset.tif")
```

The recipes carry the exact catalog ID, the exact AOI coordinates you drew, and — for time-series products — the date or date range you had selected, translated into the right `years=` or `date_start`/`date_end` arguments for that product's granularity. The browser can also export a complete, self-documenting **Jupyter notebook** (`.ipynb`) — with a metadata table, a thumbnail, install instructions, and a load-clip-plot sequence already filled in — as well as an R Markdown document. You go from a sketch on a map to a runnable, shareable analysis artifact in one click.

The natural extension is immediate: the generated recipe loads and clips the data, and from there you swap in `sdp_extract_data()` (R) or `extract_points()` / `extract_polygons()` (Python) to reproduce — and then go beyond — the zonal statistics the browser showed you. The browser's stats panel gives you the answer for one AOI; the package call gives you the answer for a thousand AOIs, in a loop, in a script you can re-run next year against an updated release.

### When to use which

A simple way to think about the division of labor:

- **Reach for the browser** when you're exploring ("what snow products cover the East River?"), choosing between products, checking that a layer looks right, grabbing numbers or a clip for a single site, building a figure, or sharing a specific view with a collaborator or in a paper. It's also the best teaching tool — students can see the data before they ever write code.

- **Reach for `rSDP` / `pySDP`** when you need reproducibility (a script that regenerates your analysis), scale (many sites, many dates, many products), integration (the SDP data is one input among many in a larger modeling or statistics pipeline), or automation (a workflow that re-runs as new data is released).

- **Use them together** in the workflow they were designed for: explore and decide in the browser, click to get the recipe, and continue in code. The browser removes the friction of *discovery and validation*; the packages provide the rigor of *reproducible analysis*. The recipe generator is the seam between them, and it's deliberately frictionless.

This is why the browser doesn't try to be a full analysis environment, and why the packages don't try to be interactive map viewers. Each does what it's best at, they share one catalog and one set of conventions, and the handoff between them is a single button.

---

## Getting started

- **The browser:** open **[sdpbrowser.org](https://sdpbrowser.org)**. Try the discovery drawer, load a product, draw an AOI, and click to copy an `rSDP` or `pySDP` recipe. Bookmark or share the URL — it carries your whole view.
- **R users:** `rSDP` — **[rmbl-sdp.github.io/rSDP](https://rmbl-sdp.github.io/rSDP/)** (`devtools::install_github('rmbl-sdp/rSDP')`).
- **Python users:** `pySDP` — **[rmbl-sdp.github.io/pySDP](https://rmbl-sdp.github.io/pySDP/)** (`pip install pysdp`).
- **The raw catalog:** the STAC catalog is open at `s3://rmbl-sdp/stac/v1/catalog.json` if you want to point your own tools (QGIS, GDAL, other STAC clients) at it.

If you find a problem with a dataset, use the **"Report an issue"** link in the browser's product detail pane — it goes straight to the maintainers, and the catalog tracks issues per product so others can see what's known.

## A note on what's coming

The browser today is a fast, read-only window onto a static catalog with in-browser extraction for modest areas. On the roadmap are larger, asynchronous extractions (hundreds of layers, many polygons, sent to a background job and returned as a download), a server-side STAC API for richer queries and dynamic mosaics ("median 2018–2024 snow-cover duration over the East River"), and pre-rendered "hero" views of the most-used products for instant loading during workshops. None of that changes the core contract: one canonical, open catalog of cloud-optimized data, reachable equally through a browser you don't have to install and through R and Python packages that turn it into reproducible science.

The Spatial Data Platform made the region's environmental data *exist in one place*. `rSDP` and `pySDP` made it *programmable*. The SDP Browser makes it *visible and shareable to everyone* — and, with one click, writes the code that connects the three.
