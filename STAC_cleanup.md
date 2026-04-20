# STAC Catalog Cleanup

Issues discovered in the RMBL SDP STAC catalog (`s3://rmbl-sdp/stac/v1/catalog.json`) while building the SDP Browser. The browser works around each of these, but the workarounds add complexity and some produce suboptimal behaviour. Fixing them upstream in the catalog generator is the right long-term path.

## Resolved in v1

- **Bare `NaN` / `Infinity` tokens** — items serialized with Python's `json.dumps(allow_nan=True)` contained tokens that aren't valid JSON. Fixed in the v1 catalog regeneration; the browser's `fetchJson` sanitation was removed.

## Active workarounds

### 1. Under-reported `raster:bands` on multi-band COGs

**Affected items:** RGB basemaps (e.g. `BM012 ug-canopy-structure-basemap`, `UG_canopy_basemap_v3.tif`) and potentially other multi-band products.

**Problem:** The STAC item declares a single `raster:bands` entry even though the underlying GeoTIFF has 3+ bands. The browser's classifier reads `bandCount=1` from the metadata and assigns `kind=singleband`, rendering with a colormap applied to band 1 instead of an RGB composite.

**Browser workaround:** On layer add, a `/cog/info` probe reads the real band count from TiTiler. If `count >= 3` and dtype is uint, the descriptor is promoted to `kind=multiband` and the layer switches to RGB rendering. The probe result is cached per item.

**Upstream fix:** Regenerate affected items with a complete `raster:bands` array (one entry per band, with name/description).

### 2. Global placeholder bbox on daily time-series items

**Affected items:** Daily time-series collections (e.g. `R4D004` max daily temperature, `R4D005` min daily temperature, and likely other daily/monthly products).

**Problem:** Item-level `bbox` is `[-180, -90, 180, 90]` instead of the actual data extent (~[-107.25, 38.43, -106.28, 39.10] for the UG domain). The `proj:epsg` and `proj:shape` properties are also missing.

**Consequences:**
- Map zooms to global extent when the layer is added.
- Tiles outside western Colorado return 0% valid pixels.
- AOI statistics drawn outside the real footprint are empty.

**Browser workaround:** `isGlobalBbox()` rejects any bbox spanning >350° lon or >170° lat and falls back to the collection-level `extent.spatial.bbox`. If that's also global/missing, the map stays at its current position.

**Upstream fix:** Compute real bounding boxes from the COG data for each item, and populate `proj:epsg` + `proj:shape`.

### 3. Missing nodata declaration on some COGs

**Affected items:** Daily temperature products and potentially others where nodata = -9999 (or similar sentinel) but isn't declared in the GeoTIFF metadata.

**Problem:** Without a declared nodata value, TiTiler includes nodata pixels in statistics (poisoning percentile-based rescale) and renders them as opaque coloured pixels instead of transparent.

**Browser workaround:** The `/cog/info` probe stashes the nodata value (when TiTiler can infer it from GDAL metadata) and passes it as an explicit `&nodata=` parameter on tile and statistics requests.

**Upstream fix:** Set the nodata value in the GeoTIFF metadata at COG creation time (`-co NODATA=-9999` or equivalent). This makes TiTiler handle it natively without explicit params.

### 4. Unscaled integer values without documented scale/offset

**Affected items:** Daily temperature products store values as scaled integers (e.g. temperature × 1000) but the STAC `raster:bands` entries don't include `scale` and `offset` fields.

**Problem:** The browser's keyword-based rescale heuristic defaults to `-30,30` (physical Celsius), but the raw COG values are in the range of -70,000 to 143,000. The initial render appears blank until auto-rescale fires and reads the real percentiles.

**Browser workaround:** Auto-rescale via `/cog/statistics` runs on layer add and applies the 2nd–98th percentile from the raw data. This produces a correct colour mapping but the legend shows raw values, not physical units.

**Upstream fix:** Either (a) populate `raster:bands[0].scale` and `raster:bands[0].offset` in the STAC metadata so the browser can convert between raw and physical units, or (b) store the COG data in physical units directly (preferred for interoperability — most tools expect un-scaled values).

### 5. Missing CRS on daily temperature COGs

**Affected items:** Daily time-series COGs (e.g. `bayes_tmax_year_2001_day_0305_est.tif` and likely all files in `UG_airtemp_2m_tmax_daily_81m_v1/`).

**Problem:** The GeoTIFF files have no CRS embedded in their metadata. TiTiler/rasterio throws `CRSError: CRS is invalid: None` when attempting to reproject to Web Mercator for tile rendering. All requests (tiles, info, statistics) fail with HTTP 500.

**Browser workaround:** None possible — CRS is required for reprojection. These layers show in the catalog but produce empty tiles when added.

**Upstream fix:** Re-embed the CRS on the affected COGs. All SDP data uses EPSG:32613:
```bash
gdal_edit.py -a_srs EPSG:32613 bayes_tmax_year_*.tif
```
Or rebuild with the CRS set during COG generation. After fixing, the existing browser code (time-series detection, calendar picker, nodata handling) should work end-to-end.

### 6. Daily time-series URL template limitations

**Affected items:** All daily (and potentially monthly) time-series collections.

**Problem:** The browser's fast-path builds a URL template by replacing the year in a sample item's asset href with `{year}`. For daily products, the href also contains a day-of-year token (e.g. `bayes_tmax_year_2001_day_0305_est.tif`) that stays hardcoded to the sample's day. Switching years in the UI shows the same DOY across years rather than letting the user pick a date.

**Browser workaround:** Default year is set to the sample item's year (guaranteed to produce a valid URL). Other years may 404 if the sample DOY doesn't exist for that year.

**Upstream fix (catalog-side):** This isn't strictly a STAC metadata issue — it's a design mismatch between daily data and the browser's year-slider UI. Options:
- Provide per-year aggregate COGs (annual composites) alongside the daily files, so the year slider has something to show.
- Add a consistent URL pattern documented in the collection metadata (e.g. `item_assets.data.href_template`) so the browser can construct URLs without guessing.

**Browser-side improvement needed:** Add a date picker for daily products instead of relying on the year slider. See `ROADMAP.md` medium-term section.
