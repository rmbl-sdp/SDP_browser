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
  // Categorical uint8: narrow default so classes get distinct colors
  // while waiting for auto-rescale to find the real range.
  if (dtype === "uint8" && firstBand?.unit === "categorical") return { rescale: "0,10", source: "heuristic" };
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
// Detects yearly / monthly / daily granularity from item link IDs and
// builds a multi-token URL template ({year}, {month}, {doy}).

const LARGE_COLLECTION_THRESHOLD = 30;

// Day-of-year for a given date.
function dayOfYear(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const jan1 = new Date(Date.UTC(year, 0, 1));
  return Math.floor((d - jan1) / 86400000) + 1;
}

// Parse the date-like numeric suffix from an item link href.
// Returns { raw, year, month?, day?, doy?, dateStr } or null.
function parseLinkDate(href) {
  const s = href || "";
  // Try ISO hyphenated date first: _YYYY-MM-DD/ (drone weekly imagery)
  const iso = s.match(/_(\d{4})-(\d{2})-(\d{2})\//);
  if (iso) {
    const y = +iso[1], mo = +iso[2], d = +iso[3];
    if (y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const doy = dayOfYear(y, mo, d);
      const raw = `${iso[1]}-${iso[2]}-${iso[3]}`;
      return { raw, year: y, month: mo, day: d, doy, dateStr: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` };
    }
  }
  // Compact numeric dates: _YYYYMMDD/, _YYYYMM/, _YYYY/
  const m = s.match(/_(\d{4,8})\//);
  if (!m) return null;
  const raw = m[1];
  if (raw.length === 8) {
    const y = +raw.slice(0, 4), mo = +raw.slice(4, 6), d = +raw.slice(6, 8);
    if (y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const doy = dayOfYear(y, mo, d);
      return { raw, year: y, month: mo, day: d, doy, dateStr: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` };
    }
  }
  if (raw.length === 6) {
    const y = +raw.slice(0, 4), mo = +raw.slice(4, 6);
    if (y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12)
      return { raw, year: y, month: mo, dateStr: `${y}-${String(mo).padStart(2,"0")}` };
  }
  if (raw.length === 4) {
    const y = +raw;
    if (y >= 1950 && y <= 2100)
      return { raw, year: y, dateStr: String(y) };
  }
  return null;
}

// Detect granularity and build the sorted dates array from item links.
function detectDatesFromLinks(links) {
  const parsed = [];
  for (const l of links) {
    const d = parseLinkDate(l.href);
    if (d) parsed.push(d);
  }
  if (parsed.length < 2) return null;
  const hasDay = parsed.every((d) => d.day != null);
  const hasMonth = parsed.every((d) => d.month != null);
  const granularity = hasDay ? "daily" : hasMonth ? "monthly" : "yearly";
  const dates = [...new Set(parsed.map((d) => d.dateStr))].sort();
  return { granularity, dates, sampleParsed: parsed[0] };
}

// Build a multi-token URL template from a sample item's COG href.
function buildTimeseriesTemplate(sampleHref, sampleParsed) {
  if (!sampleHref || !sampleParsed) return null;
  let tmpl = sampleHref;

  // Year (4 digits, standalone). Replace ALL occurrences — the year may
  // appear in both a directory path and the filename (e.g. /2022/...2022_01_26.tif).
  const yearStr = String(sampleParsed.year);
  const yearRe = new RegExp(`(^|[^0-9])${yearStr}([^0-9]|$)`, "g");
  let yearCount = 0;
  tmpl = tmpl.replace(yearRe, (_, a, b) => { yearCount++; return `${a}{year}${b}`; });
  if (yearCount < 1) return null;

  // DOY (3-4 digits, for daily granularity)
  if (sampleParsed.doy != null) {
    const doy4 = String(sampleParsed.doy).padStart(4, "0");
    const doy3 = String(sampleParsed.doy).padStart(3, "0");
    if (tmpl.includes(doy4)) tmpl = tmpl.replace(doy4, "{doy}");
    else if (tmpl.includes(doy3)) tmpl = tmpl.replace(doy3, "{doy}");
  }

  // Month + Day (for daily data without DOY, e.g. drone imagery _YYYY_MM_DD.tif)
  // Try this BEFORE the month-only case so both tokens get placed.
  if (sampleParsed.month != null && sampleParsed.day != null && !tmpl.includes("{doy}")) {
    const mm = String(sampleParsed.month).padStart(2, "0");
    const dd = String(sampleParsed.day).padStart(2, "0");
    // Look for _MM_DD pattern (underscores around month and day)
    const mdRe = new RegExp(`(_)${mm}(_)${dd}(\\b|[^0-9])`, "g");
    if (mdRe.test(tmpl)) {
      tmpl = tmpl.replace(mdRe, `$1{month}$2{day}$3`);
    } else {
      // Fallback: month-only (for monthly granularity)
      const monthRe = new RegExp(`(_(?:month_)?)${mm}(_)`, "g");
      tmpl = tmpl.replace(monthRe, `$1{month}$2`);
    }
  } else if (sampleParsed.month != null && !tmpl.includes("{doy}")) {
    const mm = String(sampleParsed.month).padStart(2, "0");
    const monthRe = new RegExp(`(_(?:month_)?)${mm}(_)`, "g");
    tmpl = tmpl.replace(monthRe, `$1{month}$2`);
  }

  return tmpl;
}

// Resolve a date string + template into a COG URL.
export function resolveTimeseriesUrl(template, dateStr) {
  if (!template || !dateStr) return null;
  const parts = dateStr.split("-");
  let url = template.replaceAll("{year}", parts[0]);
  if (parts.length >= 2) {
    url = url.replaceAll("{month}", parts[1]);
  }
  if (parts.length === 3) {
    url = url.replaceAll("{day}", parts[2]);
  }
  if (parts.length === 3 && url.includes("{doy}")) {
    const doy = dayOfYear(+parts[0], +parts[1], +parts[2]);
    const pad = template.includes("{doy}") && /\d{4}/.test(template.split("{doy}")[0].slice(-1) + "0000")
      ? 4 : (/day_\{doy\}/.test(template) ? 4 : 3);
    url = url.replace("{doy}", String(doy).padStart(pad, "0"));
  }
  return url;
}

// Format a date string for human display.
export function formatDateLabel(dateStr, granularity) {
  if (!dateStr) return "–";
  const parts = dateStr.split("-");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (granularity === "yearly") return parts[0];
  if (granularity === "monthly") return `${MONTHS[+parts[1] - 1]} ${parts[0]}`;
  return `${MONTHS[+parts[1] - 1]} ${+parts[2]}, ${parts[0]}`;
}

// Legacy: still used by the standard-path for small multi-item collections
// that were fetched in full (not fast-path).
function buildTimeseriesFromItems(items) {
  const yearsByHref = new Map();
  for (const it of items) {
    const dt = it.properties?.datetime || it.properties?.start_datetime;
    const href = it.assets?.data?.href;
    if (!dt || !href) continue;
    const y = parseInt(dt.slice(0, 4), 10);
    if (isFinite(y)) yearsByHref.set(href, y);
  }
  const years = [...new Set([...yearsByHref.values()])].sort((a, b) => a - b);
  if (years.length < 2) return null;
  const [firstHref, firstYear] = [...yearsByHref.entries()][0];
  const yearStr = String(firstYear);
  const yearRe = new RegExp(`(^|[^0-9])${yearStr}([^0-9]|$)`, "g");
  let count = 0;
  const tmpl = firstHref.replace(yearRe, (_, a, b) => { count++; return `${a}{year}${b}`; });
  if (count !== 1) return null;
  return {
    granularity: "yearly",
    dates: years.map(String),
    url_template: tmpl,
    default_date: String(firstYear),
  };
}

// --- descriptor builder ---

function isGlobalBbox(bbox) {
  if (!bbox || bbox.length < 4) return true;
  const [minx, miny, maxx, maxy] = bbox;
  return (maxx - minx) > 350 || (maxy - miny) > 170;
}

function buildDescriptor({ collection, items, collectionUrl, fastDates }) {
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
    bbox: (!isGlobalBbox(firstItem?.bbox) ? firstItem.bbox : null)
      || (!isGlobalBbox(collection.extent?.spatial?.bbox?.[0]) ? collection.extent.spatial.bbox[0] : null),
    units: bands[0]?.unit || null,
    scale: (typeof bands[0]?.scale === "number" && bands[0].scale !== 0) ? bands[0].scale : null,
    offset: typeof bands[0]?.offset === "number" ? bands[0].offset : null,
    categorical: bands[0]?.unit === "categorical",
    nodata: bands[0]?.nodata ?? null,
    bandCount,
    dtype,
    stacItemUrl: firstItem?.links?.find((l) => l.rel === "self")?.href
      || (firstItem ? resolveUrl(collectionUrl, `./${firstItem.id}/${firstItem.id}.json`) : null),
    stacCollectionUrl: collectionUrl,
    thumbnail: collection.assets?.thumbnail?.href || null,
  };

  // Time-series: try fast-path detection first (dates parsed from link
  // hrefs), then legacy item-based for small collections fetched in full.
  if (fastDates && fastDates.dates.length > 1 && asset?.href) {
    const tmpl = buildTimeseriesTemplate(asset.href, fastDates.sampleParsed);
    if (tmpl) {
      desc.kind = "timeseries";
      desc.timeseries = {
        granularity: fastDates.granularity,
        dates: fastDates.dates,
        url_template: tmpl,
        default_date: fastDates.dates[fastDates.dates.length - 1],
      };
      // Timeseries can also be multiband RGB (e.g. drone imagery, uint8 or uint16).
      if (bandCount >= 3) {
        desc.default_mode = "rgb";
        desc.default_bidx = [1, 2, 3];
        desc.bands = bands.map((b, i) => ({ idx: i + 1, name: b.name || b.description || `Band ${i + 1}` }));
        desc.default_colormap = null;
      }
    } else {
      desc.kind = "singleband";
      desc.cog_url = asset?.href;
    }
  } else if (items.length > 1) {
    const ts = buildTimeseriesFromItems(items);
    if (ts) {
      desc.kind = "timeseries";
      desc.timeseries = ts;
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

  desc.default_colormap = desc.categorical ? "tab20" : pickColormap(desc.type, desc.kind);
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
        // Fast path: parse full dates from link hrefs, fetch only 1 sample.
        const fastDates = detectDatesFromLinks(iLinks);
        const sampleItem = await fetchJson(iUrls[0]);
        if (sampleItem?._error) throw new Error(sampleItem._error);
        console.debug(
          `[fast-path] ${collection.id}: ${iUrls.length} items → 1 fetch, ${fastDates?.granularity ?? "?"} (${fastDates?.dates?.length ?? 0} dates)`,
        );
        return { collection, items: [sampleItem], fastDates, collectionUrl: curl };
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
        fastDates: entry.fastDates || null,
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
export const _internals = { buildDescriptor, detectDatesFromLinks, buildTimeseriesTemplate, computeFacets, bucketGsd, bucketBands };
