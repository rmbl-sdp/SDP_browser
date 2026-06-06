// Authenticated fetcher for the AGOL "Data Collection" feature layers
// (Point_Collection_2026, Line_Collection_2026, Polygon_Collection_2026).
//
// Mirrors the shape of sites-private.js: caller passes the access_token from
// agol-auth.js's sessionStorage cache. Pages through `exceededTransferLimit`
// the same way. Returns each layer's features tagged so a single combined
// GeoJSON FeatureCollection can be sourced into one MapLibre source.
//
// Companion to: js/sites-private.js, js/agol-auth.js.

const PAGE = 1000;
const SAFETY_CAP = 20000;

function buildQueryUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/query") ? trimmed : `${trimmed}/query`;
}

// Page through a single FeatureServer layer; returns its raw GeoJSON features.
async function fetchLayerFeatures(baseUrl, token, where = "1=1") {
  if (!token) throw new Error("Not signed in");
  const queryUrl = buildQueryUrl(baseUrl);
  const features = [];
  let offset = 0;
  while (offset < SAFETY_CAP) {
    const u = new URL(queryUrl);
    u.searchParams.set("token", token);
    u.searchParams.set("where", where);
    u.searchParams.set("outFields", "*");
    u.searchParams.set("outSR", "4326");
    u.searchParams.set("f", "geojson");
    u.searchParams.set("resultOffset", String(offset));
    u.searchParams.set("resultRecordCount", String(PAGE));
    const resp = await fetch(u.toString());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || "FeatureServer error");
    const page = data.features || [];
    features.push(...page);
    if (!data.exceededTransferLimit || page.length === 0) break;
    offset += page.length;
  }
  return features;
}

// Fetch all three Data Collection layers in parallel and return a single
// FeatureCollection with each feature tagged `_collection` ∈ {"point","line",
// "polygon"} so the map can render with type-specific symbology and the click
// handler can pick the right AOI strategy. `urls` is an object with keys
// `point`, `line`, `polygon` mapping to FeatureServer layer base URLs.
//
// Soft-fails per-layer: if one collection (e.g. Polygon_Collection_2026) is
// unavailable or returns a token error, the others still render and the
// caller gets an `errors` array describing the misses. This matters because
// not every researcher uses all three geometry types.
export async function fetchDataCollections(urls, token, where = "1=1") {
  if (!token) throw new Error("Not signed in");
  const tasks = [
    { kind: "point", url: urls.point },
    { kind: "line", url: urls.line },
    { kind: "polygon", url: urls.polygon },
  ].filter((t) => t.url);

  const results = await Promise.allSettled(
    tasks.map((t) => fetchLayerFeatures(t.url, token, where).then((feats) => ({ kind: t.kind, feats })))
  );

  const features = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      for (const f of r.value.feats) {
        f.properties = f.properties || {};
        f.properties._collection = r.value.kind;
        features.push(f);
      }
    } else {
      errors.push({ kind: tasks[i].kind, message: r.reason?.message || String(r.reason) });
    }
  });
  return { type: "FeatureCollection", features, errors };
}

// Distinct values of `field` (e.g. "Research_Plan") taken as the union across
// all three collection layers, so the filter dropdown reflects every plan that
// has at least one feature anywhere. Each layer is queried with
// `returnDistinctValues=true` so we never page through full feature lists.
//
// Like fetchDataCollections, soft-fails per layer: a missing/unavailable
// collection contributes nothing rather than failing the whole call.
export async function fetchDistinctValuesUnion(urls, token, field) {
  if (!token) throw new Error("Not signed in");
  if (!field) throw new Error("field required");
  const bases = [urls.point, urls.line, urls.polygon].filter(Boolean);
  const calls = bases.map(async (base) => {
    const queryUrl = buildQueryUrl(base);
    const u = new URL(queryUrl);
    u.searchParams.set("token", token);
    u.searchParams.set("where", `${field} IS NOT NULL`);
    u.searchParams.set("outFields", field);
    u.searchParams.set("returnDistinctValues", "true");
    u.searchParams.set("returnGeometry", "false");
    u.searchParams.set("orderByFields", field);
    u.searchParams.set("f", "json");
    const resp = await fetch(u.toString());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || "FeatureServer error");
    return (data.features || []).map((f) => f.attributes?.[field]).filter((v) => v != null && v !== "");
  });
  const results = await Promise.allSettled(calls);
  const seen = new Set();
  for (const r of results) {
    if (r.status === "fulfilled") for (const v of r.value) seen.add(String(v));
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// Build a SQL WHERE clause for a single value match. Same convention as
// sites-private.js::buildWhereForValue (double-up single quotes).
export function buildWhereForValue(field, value) {
  if (!value) return "1=1";
  const esc = String(value).replace(/'/g, "''");
  return `${field} = '${esc}'`;
}

// Approximate a circular buffer around a point as a 16-sided GeoJSON Polygon
// in WGS84. Equirectangular at mid-latitudes: dLat = m/111000, dLon =
// m/(111000·cos(lat)). Accurate to ~0.1% at RMBL's ~38.9°N for the 5-500 m
// radii we care about. Returns a Feature so it can flow straight into
// setAoi() and aoiBbox() (which reads geometry.coordinates[0] expecting a
// single outer ring).
export function pointToBufferPolygon(lng, lat, radiusMeters, vertices = 16, properties = {}) {
  const dLat = radiusMeters / 111000;
  const dLon = radiusMeters / (111000 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i < vertices; i++) {
    const t = (i / vertices) * 2 * Math.PI;
    ring.push([lng + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  ring.push(ring[0]); // close the ring
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
