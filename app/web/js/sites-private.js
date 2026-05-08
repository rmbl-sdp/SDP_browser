// Authenticated FeatureServer fetcher for the non-public ResearchSites layer.
// Pairs with agol-auth.js: caller passes the access_token from sessionStorage.

const PAGE = 1000;
const SAFETY_CAP = 20000;

function buildQueryUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/query") ? trimmed : `${trimmed}/query`;
}

export async function fetchPrivateSites(baseUrl, token, where = "1=1") {
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
  return { type: "FeatureCollection", features };
}

export async function fetchDistinctValues(baseUrl, token, field) {
  if (!token) throw new Error("Not signed in");
  if (!field) throw new Error("field required");
  const queryUrl = buildQueryUrl(baseUrl);
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
  const seen = new Set();
  for (const f of data.features || []) {
    const v = f.attributes?.[field];
    if (v != null && v !== "") seen.add(String(v));
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// Build a SQL WHERE clause for a single value match. Quote escaped per
// FeatureServer convention (double single-quotes).
export function buildWhereForValue(field, value) {
  if (!value) return "1=1";
  const esc = String(value).replace(/'/g, "''");
  return `${field} = '${esc}'`;
}
