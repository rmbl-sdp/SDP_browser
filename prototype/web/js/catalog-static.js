// Static STAC catalog walker + ItemDescriptor builder.
// Walks the RMBL SDP catalog at load time, caches the result in IndexedDB,
// and exposes a CatalogRepo interface (load / search / get) that the rest of
// the UI consumes. A future pgstac backend would implement the same interface.

import { idbGet, idbSet, idbDel } from "./idb.js";

export async function invalidateCache() {
  try { await idbDel(CACHE_KEY); } catch {}
}

const CACHE_KEY = "catalog-index-v1";

// --- colormap + rescale heuristics (used when STAC doesn't tell us) ---

const COLORMAP_BY_TYPE = {
  Topography: "terrain",
  Topo: "terrain",
  Elevation: "terrain",
  Vegetation: "ylgn",
  Veg: "ylgn",
  Snow: "ylgnbu",
  Hydro: "ylgnbu",
  Hydrology: "ylgnbu",
  Imagery: "greys",
};

// Returns { rescale: "min,max", source: "stac" | "heuristic" }.
// Keyword heuristics are only a fallback when STAC statistics are absent;
// the UI uses the source field to decide whether to try an on-demand
// auto-rescale from TiTiler /cog/statistics.
function pickRescale(firstBand, desc, collection) {
  // 1. Item-level statistics on the data asset.
  const statsCandidates = [
    firstBand?.statistics,
    collection?.item_assets?.data?.["raster:bands"]?.[0]?.statistics,
    collection?.summaries?.["raster:bands"]?.[0]?.statistics,
  ];
  for (const s of statsCandidates) {
    if (!s) continue;
    const lo = s.minimum ?? s.min;
    const hi = s.maximum ?? s.max;
    if (isFinite(lo) && isFinite(hi) && hi > lo) {
      return { rescale: `${lo},${hi}`, source: "stac" };
    }
  }
  const dtype = firstBand?.data_type || "";
  if (dtype === "uint8") return { rescale: "0,255", source: "heuristic" };
  if (dtype === "uint16") return { rescale: "0,10000", source: "heuristic" };
  const t = (desc.title + " " + (desc.description || "")).toLowerCase();
  if (/elev|dem|digital elevation/.test(t)) return { rescale: "2500,4400", source: "heuristic" };
  if (/slope/.test(t)) return { rescale: "0,60", source: "heuristic" };
  if (/aspect.*south|southness/.test(t)) return { rescale: "-1,1", source: "heuristic" };
  if (/ndvi/.test(t)) return { rescale: "-0.2,0.9", source: "heuristic" };
  if (/snow.*(duration|length|persistence)/.test(t)) return { rescale: "0,250", source: "heuristic" };
  if (/temperature|tmax|tmin/.test(t)) return { rescale: "-30,30", source: "heuristic" };
  return { rescale: "0,1", source: "heuristic" };
}

function pickColormap(type, kind) {
  if (kind === "multiband") return null;
  return COLORMAP_BY_TYPE[type] || "viridis";
}

// --- url helpers ---

function resolveUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function childLinks(doc) {
  return (doc.links || []).filter((l) => l.rel === "child");
}
function itemLinks(doc) {
  return (doc.links || []).filter((l) => l.rel === "item");
}

// --- concurrency pool ---

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { _error: e.message, _src: items[i] }; }
    }
  }
  await Promise.all(
    Array(Math.min(limit, items.length)).fill(0).map(worker),
  );
  return out;
}

// --- time-series detection ---

// Parse 4-digit years from item link hrefs / IDs without fetching items.
// This is the key to making the walk fast: a daily time-series collection
// may have thousands of item links, but we only need to know which *years*
// are covered (the UI exposes a year slider, not a day slider).
function parseYearsFromLinks(links) {
  const years = new Set();
  for (const l of links) {
    const href = l.href || "";
    const m = href.match(/(\d{4})/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1950 && y <= 2100) years.add(y);
    }
  }
  return [...years].sort((a, b) => a - b);
}

// Build a URL template from a sample item's asset href + a known year.
function buildUrlTemplate(sampleHref, sampleYear) {
  if (!sampleHref || !sampleYear) return null;
  const yearStr = String(sampleYear);
  const yearRe = new RegExp(`(^|[^0-9])${yearStr}([^0-9]|$)`, "g");
  let count = 0;
  const tmpl = sampleHref.replace(yearRe, (_, a, b) => { count++; return `${a}{year}${b}`; });
  return count === 1 ? tmpl : null;
}

function buildTimeseries(items) {
  const yearsByHref = new Map();
  for (const it of items) {
    const dt = it.properties?.datetime || it.properties?.start_datetime;
    const href = it.assets?.data?.href;
    if (!dt || !href) continue;
    const y = parseInt(dt.slice(0, 4), 10);
    if (isFinite(y)) yearsByHref.set(href, y);
  }
  const years = [...new Set([...yearsByHref.values()])].sort((a, b) => a - b);
  if (years.length < 2) return { url_template: null, years };
  const [firstHref, firstYear] = [...yearsByHref.entries()][0];
  return { url_template: buildUrlTemplate(firstHref, firstYear), years };
}

// Threshold: collections with more item links than this use the fast path
// (parse years from link hrefs, fetch only 1 sample item).
const LARGE_COLLECTION_THRESHOLD = 30;

// --- descriptor builder ---

function buildDescriptor({ collection, items, collectionUrl, fastYears }) {
  const firstItem = items[0];
  const asset = firstItem?.assets?.data || null;
  const bands =
    asset?.["raster:bands"] ||
    firstItem?.properties?.["raster:bands"] ||
    collection.item_assets?.data?.["raster:bands"] ||
    collection.summaries?.["raster:bands"] ||
    [];
  const bandCount = bands.length;
  const dtype = bands[0]?.data_type || "";

  const desc = {
    id: collection.id,
    title: collection.title || collection.id,
    description: collection.description || "",
    domain: collection["rmbl:domain"] || null,
    release: collection["rmbl:release"] || null,
    type: collection["rmbl:type"] || null,
    rsdp_id: collection["rmbl:catalog_id"] || null,
    gsd: collection.summaries?.gsd?.[0] ?? firstItem?.properties?.gsd ?? null,
    epsg: firstItem?.properties?.["proj:epsg"] ?? collection.summaries?.["proj:epsg"]?.[0] ?? null,
    temporal: collection.extent?.temporal?.interval?.[0] || [null, null],
    bbox: firstItem?.bbox || collection.extent?.spatial?.bbox?.[0] || null,
    units: bands[0]?.unit || null,
    bandCount,
    dtype,
    stacItemUrl: firstItem?.links?.find((l) => l.rel === "self")?.href
      || (firstItem ? resolveUrl(collectionUrl, `./${firstItem.id}/${firstItem.id}.json`) : null),
    stacCollectionUrl: collectionUrl,
    thumbnail: collection.assets?.thumbnail?.href || null,
  };

  // Fast-path time-series: years were parsed from link hrefs, only 1 sample
  // item was fetched. Build the URL template from that sample.
  if (fastYears && fastYears.length > 1 && asset?.href) {
    const sampleDt = firstItem?.properties?.datetime || firstItem?.properties?.start_datetime;
    const sampleYear = sampleDt ? parseInt(sampleDt.slice(0, 4), 10) : fastYears[0];
    const url_template = buildUrlTemplate(asset.href, sampleYear);
    if (url_template) {
      // For daily series the template bakes in a specific DOY from the sample
      // item. Default to the sample's year so the initial tile request is
      // guaranteed to resolve; other years may produce 404s for that DOY.
      desc.kind = "timeseries";
      desc.url_template = url_template;
      desc.years = fastYears;
      desc.default_year = sampleYear;
    } else {
      desc.kind = "singleband";
      desc.cog_url = asset.href;
    }
  } else if (items.length > 1) {
    const { url_template, years } = buildTimeseries(items);
    if (url_template && years.length > 1) {
      desc.kind = "timeseries";
      desc.url_template = url_template;
      desc.years = years;
      desc.default_year = years[years.length - 1];
    } else {
      desc.kind = "singleband";
      desc.cog_url = asset?.href;
    }
  } else if (bandCount >= 3 && dtype === "uint8") {
    desc.kind = "multiband";
    desc.cog_url = asset?.href;
    desc.bands = bands.map((b, i) => ({ idx: i + 1, name: b.name || b.description || `Band ${i + 1}` }));
    desc.default_mode = "rgb";
    desc.default_bidx = [1, 2, 3];
  } else if (asset?.href) {
    desc.kind = "singleband";
    desc.cog_url = asset.href;
  } else {
    desc.kind = "unsupported";
  }

  desc.default_colormap = pickColormap(desc.type, desc.kind);
  const rs = pickRescale(bands[0], desc, collection);
  desc.default_rescale = rs.rescale;
  desc.rescale_source = rs.source;
  return desc;
}

// --- walker ---

export async function walkCatalog(rootUrl, onProgress) {
  const root = await fetchJson(rootUrl);
  const domainUrls = childLinks(root).map((l) => resolveUrl(rootUrl, l.href));
  const domains = await parallelMap(domainUrls, 4, fetchJson);

  const collectionUrls = [];
  domains.forEach((d, i) => {
    if (d?._error) return;
    childLinks(d).forEach((l) =>
      collectionUrls.push(resolveUrl(domainUrls[i], l.href)),
    );
  });

  let done = 0;
  const total = collectionUrls.length;
  onProgress?.({ done: 0, total, stage: "collections" });

  const entries = await parallelMap(collectionUrls, 10, async (curl) => {
    try {
      const collection = await fetchJson(curl);
      const iLinks = itemLinks(collection);
      const iUrls = iLinks.map((l) => resolveUrl(curl, l.href));

      if (iUrls.length > LARGE_COLLECTION_THRESHOLD) {
        // Fast path: parse years from link hrefs, fetch only 1 sample item.
        // Saves thousands of fetches for daily time-series collections.
        const fastYears = parseYearsFromLinks(iLinks);
        const sampleItem = await fetchJson(iUrls[0]);
        if (sampleItem?._error) throw new Error(sampleItem._error);
        console.debug(
          `[fast-path] ${collection.id}: ${iUrls.length} items → 1 fetch, ${fastYears.length} years`,
        );
        return { collection, items: [sampleItem], fastYears, collectionUrl: curl };
      }

      // Standard path: fetch all items (small collections).
      const items = await parallelMap(iUrls, 4, fetchJson);
      const failedItems = items.filter((i) => i && i._error);
      if (failedItems.length) console.warn("items failed in", curl, failedItems);
      return { collection, items: items.filter((i) => i && !i._error), collectionUrl: curl };
    } catch (e) {
      console.warn("collection fetch failed:", curl, e.message || e);
      throw e;
    } finally {
      done += 1;
      onProgress?.({ done, total, stage: "collections" });
    }
  });

  const descriptors = [];
  for (const entry of entries) {
    if (entry?._error) { console.warn("catalog walk error:", entry._error); continue; }
    if (!entry?.items?.length) continue;
    try {
      descriptors.push(buildDescriptor({
        collection: entry.collection,
        items: entry.items,
        collectionUrl: entry.collectionUrl,
        fastYears: entry.fastYears || null,
      }));
    } catch (e) { console.warn("descriptor build error:", entry.collection?.id, e); }
  }
  return descriptors;
}

// --- facet aggregation ---

function bucketGsd(g) {
  if (g == null) return "unknown";
  if (g <= 1) return "≤ 1 m";
  if (g <= 5) return "1–5 m";
  if (g <= 10) return "5–10 m";
  return "> 10 m";
}
function bucketBands(n) {
  if (!n || n === 1) return "1";
  if (n <= 3) return "2–3";
  return "4+";
}

export function computeFacets(descriptors) {
  const tally = () => ({});
  const f = { domain: tally(), release: tally(), type: tally(), gsd: tally(), bands: tally() };
  let yMin = Infinity, yMax = -Infinity;
  for (const d of descriptors) {
    for (const key of ["domain", "release", "type"]) {
      const v = d[key] || "unspecified";
      f[key][v] = (f[key][v] || 0) + 1;
    }
    const gsdKey = bucketGsd(d.gsd);
    f.gsd[gsdKey] = (f.gsd[gsdKey] || 0) + 1;
    const bKey = bucketBands(d.bandCount);
    f.bands[bKey] = (f.bands[bKey] || 0) + 1;
    const start = d.temporal?.[0] ? new Date(d.temporal[0]).getUTCFullYear() : null;
    const end = d.temporal?.[1] ? new Date(d.temporal[1]).getUTCFullYear() : null;
    if (start && start < yMin) yMin = start;
    if (end && end > yMax) yMax = end;
  }
  const yearRange = isFinite(yMin) && isFinite(yMax) ? [yMin, yMax] : null;
  return { ...f, yearRange };
}

// --- cache ---

async function hashString(s) {
  if (!("crypto" in window) || !crypto.subtle) return null;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rootFingerprint(rootUrl) {
  // Prefer ETag; fall back to body hash.
  try {
    const head = await fetch(rootUrl, { method: "HEAD" });
    const etag = head.headers.get("etag");
    if (etag) return { etag, hash: null };
  } catch {}
  try {
    const body = await (await fetch(rootUrl)).text();
    return { etag: null, hash: await hashString(body) };
  } catch { return { etag: null, hash: null }; }
}

// --- repo ---

export async function loadRepo({ rootUrl, onProgress, force = false } = {}) {
  const fp = await rootFingerprint(rootUrl);
  const cached = !force ? await idbGet(CACHE_KEY).catch(() => null) : null;
  const cacheHit =
    cached &&
    ((fp.etag && cached.fp?.etag === fp.etag) ||
     (!fp.etag && cached.fp?.hash && cached.fp?.hash === fp.hash));

  let descriptors;
  let fromCache = false;
  if (cacheHit) {
    descriptors = cached.descriptors;
    fromCache = true;
    onProgress?.({ done: descriptors.length, total: descriptors.length, stage: "cache" });
  } else {
    descriptors = await walkCatalog(rootUrl, onProgress);
    try {
      await idbSet(CACHE_KEY, {
        fp, builtAt: Date.now(), descriptors, rootUrl,
      });
    } catch (e) { console.warn("idb cache write failed:", e); }
  }

  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const facets = computeFacets(descriptors);

  return {
    all: () => descriptors,
    get: (id) => byId.get(id) || null,
    facets,
    fromCache,
    builtAt: cached?.builtAt || Date.now(),
    search: (opts) => searchDescriptors(descriptors, opts || {}),
  };
}

export { searchDescriptors };

export function makeInMemoryRepo(descriptors, { fallback = false } = {}) {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return {
    all: () => descriptors,
    get: (id) => byId.get(id) || null,
    facets: computeFacets(descriptors),
    fromCache: false,
    builtAt: Date.now(),
    search: (opts) => searchDescriptors(descriptors, opts || {}),
    fallback,
  };
}

function searchDescriptors(descriptors, { q = "", selected = {}, yearRange = null } = {}) {
  const needle = q.trim().toLowerCase();
  const matches = (d) => {
    if (needle) {
      const hay = `${d.id} ${d.title} ${d.description} ${d.type || ""} ${d.rsdp_id || ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    for (const k of ["domain", "release", "type"]) {
      if (selected[k]?.size && !selected[k].has(d[k] || "unspecified")) return false;
    }
    if (selected.gsd?.size && !selected.gsd.has(bucketGsd(d.gsd))) return false;
    if (selected.bands?.size && !selected.bands.has(bucketBands(d.bandCount))) return false;
    if (yearRange) {
      const s = d.temporal?.[0] ? new Date(d.temporal[0]).getUTCFullYear() : null;
      const e = d.temporal?.[1] ? new Date(d.temporal[1]).getUTCFullYear() : null;
      if (s == null && e == null) return false;
      const lo = s ?? e, hi = e ?? s;
      if (hi < yearRange[0] || lo > yearRange[1]) return false;
    }
    return true;
  };
  return descriptors.filter(matches);
}

// Helper used by the UI to build STAC Browser links.
export function stacBrowserLink(stacUrl) {
  return `https://radiantearth.github.io/stac-browser/#/external/${encodeURIComponent(stacUrl).replace(/%2F/g, "/")}`;
}

// Expose helpers mostly for testing / debugging in devtools.
export const _internals = { buildDescriptor, buildTimeseries, computeFacets, bucketGsd, bucketBands };
