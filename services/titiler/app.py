"""SDP Browser TiTiler tile server.

Reads COGs from S3 (anonymous by default) and exposes TiTiler's standard
``/cog/*`` endpoints. GDAL / VSI env vars are the tuned set carried over
from ``bloom_forecast_vis``; they must be set before ``rasterio`` is
imported, so we set them here at module load time.

Configuration (all via environment variables):

  AWS_NO_SIGN_REQUEST   "YES" (default) to read public buckets anonymously.
  AWS_DEFAULT_REGION    Defaults to us-east-2 (same region as rmbl-sdp).
  CORS_ORIGINS          Comma-separated list of allowed origins for CORS.
                        Defaults to "*" for local dev; set to the app's
                        CloudFront / custom-domain origin in production.
  LOG_LEVEL             Passed through to uvicorn (default: info).
"""
import os

# Anonymous S3 access — the rmbl-sdp bucket is public. Flip off via env var
# when pointing at a private bucket.
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")

# GDAL / VSI tuning for COGs read over HTTP from S3.
os.environ.setdefault("GDAL_CACHEMAX", "200")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "52428800")  # 50 MB
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.vrt,.json")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")

from rasterio.crs import CRS  # noqa: E402
from rasterio.vrt import WarpedVRT  # noqa: E402
from rio_tiler.io import Reader as BaseReader  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from titiler.core.errors import DEFAULT_STATUS_CODES, add_exception_handlers  # noqa: E402
from titiler.core.factory import TilerFactory  # noqa: E402

# All SDP COGs are EPSG:32613 (UTM 13N). Some daily temperature products
# were built without embedding the CRS in the GeoTIFF metadata. This
# custom reader injects the default CRS so TiTiler can still reproject
# and serve tiles for those files.
SDP_DEFAULT_CRS = CRS.from_epsg(32613)


class SDPReader(BaseReader):
    """rio-tiler Reader that falls back to EPSG:32613 when the source CRS is missing."""

    def __attrs_post_init__(self):
        super().__attrs_post_init__()
        if self.dataset.crs is None or self.crs is None:
            self.dataset = WarpedVRT(self.dataset, src_crs=SDP_DEFAULT_CRS)
            self.crs = SDP_DEFAULT_CRS
            self.bounds = self.dataset.bounds


# Restrict which S3 URLs TiTiler will serve. Without this, the tile API
# is an open proxy for arbitrary public rasters, consuming our compute.
ALLOWED_URL_PREFIXES = [
    p.strip() for p in os.environ.get(
        "ALLOWED_URL_PREFIXES",
        "https://rmbl-sdp.s3.us-east-2.amazonaws.com/,"
        "https://rmbl-sdp.s3.amazonaws.com/"
    ).split(",") if p.strip()
]

app = FastAPI(title="SDP Browser TiTiler", version="0.1.0")

_cors_raw = os.environ.get("CORS_ORIGINS", "*").strip()
_cors_origins = (
    ["*"] if _cors_raw == "*" else [o.strip() for o in _cors_raw.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Origin"],
)

@app.middleware("http")
async def add_cache_headers(request, call_next):
    """Add Cache-Control to tile responses so browsers + CDN cache them."""
    response = await call_next(request)
    if "/tiles/" in request.url.path:
        # 30 days + immutable on 2xx ONLY. Year-keyed COGs are immutable and
        # restyling changes the URL, so the long TTL is safe for cache hits.
        # Errors (404 out-of-bounds, 500 server errors) get no-store so a
        # transient failure doesn't lock a broken response in the browser
        # cache for 30 days.
        if 200 <= response.status_code < 300:
            response.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        else:
            response.headers["Cache-Control"] = "no-store"
    return response


cog = TilerFactory(reader=SDPReader)
app.include_router(cog.router, prefix="/cog", tags=["COG"])
add_exception_handlers(app, DEFAULT_STATUS_CODES)


@app.middleware("http")
async def validate_url_param(request, call_next):
    """Block requests whose `url` query parameter points outside the allowed S3 prefixes."""
    url_param = request.query_params.get("url", "")
    if url_param and ALLOWED_URL_PREFIXES:
        if not any(url_param.startswith(p) for p in ALLOWED_URL_PREFIXES):
            from starlette.responses import JSONResponse
            return JSONResponse({"detail": "URL not in allowed prefix list"}, status_code=403)
    return await call_next(request)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
