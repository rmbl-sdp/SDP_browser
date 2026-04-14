"""Prototype TiTiler server for SDP Browser.

Reads COGs directly from public S3 (anonymous) and exposes TiTiler's
standard `/cog/*` endpoints. GDAL env vars below are the tuned set
carried over from bloom_forecast_vis; they must be set before rasterio
is imported, so we set them here at module load time.
"""
import os

# Anonymous S3 access — the rmbl-sdp bucket is public.
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")

# GDAL / VSI tuning for reading COGs over HTTP from S3.
os.environ.setdefault("GDAL_CACHEMAX", "200")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "52428800")  # 50 MB
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.vrt,.json")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from titiler.core.errors import DEFAULT_STATUS_CODES, add_exception_handlers  # noqa: E402
from titiler.core.factory import TilerFactory  # noqa: E402

app = FastAPI(title="SDP Browser Prototype TiTiler", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # prototype-only; lock down in Phase 1
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

cog = TilerFactory()
app.include_router(cog.router, prefix="/cog", tags=["COG"])
add_exception_handlers(app, DEFAULT_STATUS_CODES)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
