# Data Collection feature layers as AOIs

> **Status: shipped in v0.2.** This doc is the original design + implementation
> plan; behavior described below matches what's live on
> [sdpbrowser.org](https://sdpbrowser.org), with a few refinements made during
> integration (labels rethought to "2025 research sites (curated)" + "2026
> research sites (live)" instead of generic names; the AGOL controls moved to
> a dedicated full-width bar that appears on sign-in; the 2026 live overlay
> auto-loads on sign-in and on session restore; ESRI Field Maps GNSS metadata
> is filtered from feature popups).

Design + implementation plan for surfacing the AGOL "Data Collection 2026"
Point / Line / Polygon FeatureServer layers in the SDP Browser, filterable by
`Research_Plan`, with one-click "use as AOI" behavior including small-buffer
materialization for point features.

## Scope

Three AGOL FeatureServer endpoints on the same org as `ResearchSites_2026`:

- `…/services/Point_Collection_2026/FeatureServer/…`
- `…/services/Line_Collection_2026/FeatureServer/…`
- `…/services/Polygon_Collection_2026/FeatureServer/…`

All three are private (return `Token Required` unauthenticated), so they reuse
the existing AGOL OAuth 2.0 / PKCE flow from `agol-auth.js` and the same token
that already drives My Research Sites.

User-visible behavior:

1. After the user signs in (existing flow), a new control surfaces alongside
   My Research Sites: **Data Collection** with a **Research Plan** filter
   dropdown.
2. Selecting a plan (or "All") fetches all three layers in parallel, filtered
   server-side by `Research_Plan = '<value>'` (or `1=1`), and renders them on
   the map with type-distinct styling.
3. Clicking any feature opens the existing popup. The "Use as AOI" button
   sets it as the current AOI (replacing whatever AOI is there), draws stats,
   and updates the recipe panel — exactly as a draw-tool polygon does.
   - **Polygon** features: feature geometry used directly via the existing
     `useFeatureAsAoi → coordsBBox` path.
   - **Line** features: same path. The existing helper already reduces lines
     to their bbox.
   - **Point** features: buffered to a ~30 m-radius polygon (configurable)
     via the new `pointToBufferPolygon` helper.

## What already exists (and can be reused as-is)

Mapped out from `prototype/web/index.html`:

| Concern | Existing seam | Reuse for new feature? |
|---|---|---|
| AGOL OAuth (PKCE) flow | `js/agol-auth.js`, used by My Sites | **Yes, unchanged.** Same token, same client ID. |
| Per-layer paged FeatureServer fetch | `js/sites-private.js::fetchPrivateSites` | Same shape; new module replicates the loop. |
| Distinct-value dropdown source | `js/sites-private.js::fetchDistinctValues` | Same shape; new module unions across 3 layers. |
| SQL-WHERE builder | `js/sites-private.js::buildWhereForValue` | New module re-implements identically (same convention). |
| Map source + 3 layer types (fill/line/circle) | `MY_LAYER_IDS` / `ensureMySitesLayers` at `index.html:1842-1902` | Pattern copied verbatim with new IDs + new accent color. |
| Click popup + "Use as AOI" button | `MY_LAYER_IDS.forEach(map.on("click", …))` at `index.html:1873-1898` | Same code shape; new layer IDs. |
| **Click → AOI for polygons & lines** | `useFeatureAsAoi(feature, clickPt)` at `index.html:1815`, which goes through `coordsForClick → coordsBBox → setAoi(Polygon)` | **Works as-is** for both. Lines collapse to their bbox already. |
| AOI rendering, stats, recipes | `setAoi(feature)` at `index.html:3805`, `aoiBbox()` at 3818 | Unchanged. New code feeds these the same `Polygon` Feature shape they already expect. |

## What's actually new

Smaller than it looks. Three things:

### 1. `prototype/web/js/data-collection.js` (new, scaffolded — already in repo)

A new ES module with:

- **`fetchDataCollections(urls, token, where)`** — fetches all three layers in
  parallel with `Promise.allSettled` (soft-fails per layer so a missing
  Polygon collection doesn't break the others), tags each feature with
  `properties._collection ∈ {"point","line","polygon"}` for client-side
  styling + click routing, returns a single `FeatureCollection` plus an
  `errors[]` array.
- **`fetchDistinctValuesUnion(urls, token, field)`** — unions distinct
  `Research_Plan` values across the three layers (so the dropdown is
  complete regardless of which layer carries the plan).
- **`buildWhereForValue(field, value)`** — same convention as
  `sites-private.js` (double-up single quotes for SQL escape).
- **`pointToBufferPolygon(lng, lat, radiusMeters, vertices=16, properties={})`** —
  16-sided regular polygon approximating a circle in WGS84, equirectangular
  at mid-latitudes (accurate to ~0.1% at RMBL's ~38.9°N for 5–500 m radii).
  Returns a GeoJSON `Polygon` Feature that flows directly into the existing
  `setAoi()` and `aoiBbox()` (both expect a single outer ring).

### 2. Integration in `prototype/web/index.html` (changes localized to known seams)

Touching only the following anchors; no architectural change required.

| Seam | Edit |
|---|---|
| Config block at lines ~1217-1222 | Add `AGOL_DATA_COLLECTION_URLS = { point, line, polygon }` constant (override via runtime `config.js` for staging/prod, same shape as the existing private-sites URL). |
| Imports at line 1211 | `import { fetchDataCollections, fetchDistinctValuesUnion, buildWhereForValue as dcWhere, pointToBufferPolygon } from "./js/data-collection.js";` |
| State block at line ~1254 | Add `dataCollectionOn: false, dataCollectionPlan: "", dataCollectionPlanChoices: null, dataCollectionFeatures: null`. |
| Map layers, paralleling `ensureMySitesLayers` at line 1844 | New `ensureDataCollectionLayers()` creates one `geojson` source with three sublayers (`dc-fill`, `dc-line`, `dc-point`) using a distinct accent color (proposed: `#F5A33C`, warm orange so it reads as different from both the cyan My Sites and the public-sites orange). Each sublayer's filter uses the existing `["geometry-type"]` MapLibre expression. |
| Click popup, copy of lines 1873-1898 | Same template, but the "Use as AOI" callback routes Points through `pointToBufferPolygon(lng, lat, AOI_POINT_BUFFER_M)` and calls `setAoi(poly)` directly instead of going through `useFeatureAsAoi`. Polygons/lines call the existing `useFeatureAsAoi(f, [lng,lat])` unchanged. |
| HTML — the AGOL drawer where "My Research Sites" lives at line ~1136 | Add a parallel block: toggle checkbox, plan dropdown, "loading…" / error hint. Wire to the new state. |
| Event wiring near lines 4515-4629 (existing AGOL sign-in handler) | After the existing `state.myResearcherChoices` lazy-load, add a parallel lazy-load for `state.dataCollectionPlanChoices` (so signing in pre-fetches the plan list, same UX). Subscribe to the new toggle + dropdown change events. |

Net diff estimate: ~120 lines added, ~5 lines modified. No deletions.

### 3. Defensive fix worth bundling: `useFeatureAsAoi` on `Point`

`useFeatureAsAoi` currently runs `coordsBBox` on the geometry, which for a
Point yields `[lng, lat, lng, lat]` — a zero-area bbox. Today this can be
hit by clicking a point in the public Research Sites or My Research Sites
overlays, silently producing an empty AOI. Worth fixing once, here, so every
caller benefits:

```js
function useFeatureAsAoi(feature, clickPt) {
  if (feature?.geometry?.type === "Point") {
    const [lng, lat] = feature.geometry.coordinates;
    setAoi(pointToBufferPolygon(lng, lat, AOI_POINT_BUFFER_M));
    fetchStats();
    return;
  }
  // existing path…
}
```

With this in place, the new Data Collection click handler can just call
`useFeatureAsAoi` uniformly — no Point-specific branch at the call site.

## Configuration

Runtime config (so staging vs production can point at different AGOL items if
needed, e.g. a "Data Collection 2026 Test" view), following the existing
`config.js` pattern:

```js
// app/web/config.example.js, etc.
window.__SDP_CONFIG__ = {
  // …existing keys…
  AGOL_DATA_COLLECTION_URLS: {
    point:   "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Point_Collection_2026/FeatureServer/0",
    line:    "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Line_Collection_2026/FeatureServer/0",
    polygon: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Polygon_Collection_2026/FeatureServer/0",
  },
  AGOL_DATA_COLLECTION_PLAN_FIELD: "Research_Plan",
  AGOL_DATA_COLLECTION_POINT_BUFFER_M: 30,
};
```

The exact `/0` layer index (vs `/14` for ResearchSites) needs verification
once a token is available — the FeatureServer root may expose multiple
layers per item. I cannot probe without auth.

## Open questions / things to confirm

1. **Layer index on the FeatureServer.** The existing ResearchSites uses
   `/14`. Single-item FeatureServers usually start at `/0`. **Need a
   token to confirm.** First wiring run will surface this; fallback is a
   tiny "discover layers" helper that probes `/0..N` for the right one.
2. **Default point buffer radius.** Proposed 30 m as a baseline (typical
   handheld-GPS plot scale at RMBL). If your collection plans target a
   different scale we should bake in a different default — easy to revisit.
   The feature schema may also carry a per-feature `Plot_Radius` or similar
   that we could use preferentially; flag during integration if present.
3. **Symbology.** Proposed `#F5A33C` (warm orange) for the Data Collection
   layers, distinct from the public-sites orange (which is more red-ish)
   and the My Sites cyan. Final color is bikeshed-friendly.
4. **Persistence.** Should the active Data Collection plan be encoded into
   the URL hash like the catalog layer state? Probably yes, to make
   shareable URLs to a specific plan view work — `dcp=Plan%20Name`.
   Trivial addendum to `writeKv/readKv`.
5. **Recipe export for buffered points.** When the AOI is a buffered point,
   the emitted rSDP / pySDP recipe currently embeds the bbox of the polygon
   — which is fine (it's a Polygon Feature like any other). Open question:
   should the recipe instead embed `terra::buffer(pt, 30)` / `gdf.buffer(30)`
   to make the buffering explicit? Worth a short discussion before deciding.

## Recommended sequence

1. **Land the foundation** (already drafted): `js/data-collection.js` —
   self-contained, no `index.html` changes. Already in this branch.
2. **Wire `index.html`** behind the existing AGOL sign-in: state, layers,
   popup, toggle/dropdown. Test against the live AGOL endpoints in the
   prototype Docker sandbox.
3. **Defensive `useFeatureAsAoi` Point fix** — easy and improves existing
   behavior, ship in the same PR.
4. **Optional follow-ups:** URL-hash persistence (`dcp=`); recipe
   awareness of "this AOI is a buffered point"; per-feature plot-radius
   override if such an attribute exists.

Items 1–3 are roughly a half day of work once the AGOL layer indices and
default buffer radius are confirmed.
