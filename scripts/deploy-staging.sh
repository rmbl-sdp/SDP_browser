#!/usr/bin/env bash
set -euo pipefail

# Deploy the SDP Browser staging environment.
#
# Prerequisites:
#   - AWS CLI profile "sdp-browser-admin" configured
#   - Docker with buildx (for cross-compiling amd64 on ARM Macs)
#   - Terraform >= 1.5
#
# Usage:
#   ./scripts/deploy-staging.sh          # full deploy (image + infra + site)
#   ./scripts/deploy-staging.sh site     # site-only (skip image + infra)
#   ./scripts/deploy-staging.sh image    # image-only (rebuild + push + ECS restart)

AWS_PROFILE="sdp-browser-admin"
AWS_REGION="us-east-2"
ECR_REPO="254459631110.dkr.ecr.us-east-2.amazonaws.com/sdp-browser-staging-titiler"
ECS_CLUSTER="sdp-browser-staging-cluster"
ECS_SERVICE="sdp-browser-staging-svc"
SITE_BUCKET="sdp-browser-staging-site"
SITE_DIST="E39430E8ZWZD89"
API_DIST="E317KMYYHDLK45"
API_DOMAIN="api.sdpbrowser.org"
AGOL_CLIENT_ID="73IpknmLfeXEBLAf"
AGOL_PRIVATE_SITES_URL="https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/ResearchSites_2026/FeatureServer/14"
AGOL_RESEARCHER_FIELD="Researcher"
TF_DIR="infra/envs/staging"
MODE="${1:-full}"

cd "$(dirname "$0")/.."

echo "=== SDP Browser staging deploy (mode: $MODE) ==="

# ---------- 1. Sync prototype → app (config shim) ----------
if [[ "$MODE" == "full" || "$MODE" == "site" ]]; then
  echo "→ Syncing prototype/web → app/web..."
  cp prototype/web/js/catalog-static.js app/web/js/catalog-static.js
  cp prototype/web/js/idb.js app/web/js/idb.js
  cp prototype/web/js/agol-auth.js app/web/js/agol-auth.js
  cp prototype/web/js/sites-private.js app/web/js/sites-private.js
  cp prototype/web/js/data-collection.js app/web/js/data-collection.js
  cp prototype/web/js/export-compose.js app/web/js/export-compose.js
  cp prototype/web/catalog.json app/web/catalog.json
  cp prototype/web/rmbl-logo.png app/web/rmbl-logo.png
  cp prototype/web/favicon.svg app/web/favicon.svg
  cp prototype/web/oauth-callback.html app/web/oauth-callback.html

  # Copy index.html then re-apply the config.js shim.
  cp prototype/web/index.html app/web/index.html

  # Patch: add config.js script tag + SDP_CONFIG wrapper.
  python3 -c "
import re
with open('app/web/index.html') as f:
    html = f.read()

# Add config.js script tag before the module script
html = html.replace(
    '<script type=\"module\">',
    '<script src=\"./config.js\"></script>\n    <script type=\"module\">',
    1
)

# Wrap STAC_ROOT
html = html.replace(
    'const STAC_ROOT = \"https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json\";',
    'const SDP_CONFIG = (typeof window !== \"undefined\" && window.__SDP_CONFIG__) || {};\n      const STAC_ROOT = SDP_CONFIG.STAC_ROOT || \"https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json\";'
)

# Wrap TITILER
html = html.replace(
    'const TITILER = \"http://localhost:8000\";',
    'const TITILER = SDP_CONFIG.TITILER || \"http://localhost:8000\";'
)

# Wrap SITES_QUERY_URL
html = re.sub(
    r'const SITES_QUERY_URL =\n\s+\"(https://services8[^\"]+)\";',
    r'const SITES_QUERY_URL = SDP_CONFIG.SITES_QUERY_URL\n        || \"\1\";',
    html
)

# Wrap AGOL_CLIENT_ID
html = re.sub(
    r'const AGOL_CLIENT_ID = \"([^\"]+)\";',
    r'const AGOL_CLIENT_ID = SDP_CONFIG.AGOL_CLIENT_ID || \"\1\";',
    html
)

# Wrap AGOL_PRIVATE_SITES_URL (multi-line)
html = re.sub(
    r'const AGOL_PRIVATE_SITES_URL =\n\s+\"(https://services8[^\"]+)\";',
    r'const AGOL_PRIVATE_SITES_URL = SDP_CONFIG.AGOL_PRIVATE_SITES_URL\n        || \"\1\";',
    html
)

# Wrap AGOL_RESEARCHER_FIELD
html = re.sub(
    r'const AGOL_RESEARCHER_FIELD = \"([^\"]+)\";',
    r'const AGOL_RESEARCHER_FIELD = SDP_CONFIG.AGOL_RESEARCHER_FIELD || \"\1\";',
    html
)

# Wrap AGOL_DATA_COLLECTION_URLS (multi-line object literal)
html = re.sub(
    r'const AGOL_DATA_COLLECTION_URLS = (\\{[^}]+\\});',
    r'const AGOL_DATA_COLLECTION_URLS = SDP_CONFIG.AGOL_DATA_COLLECTION_URLS || \\1;',
    html
)

# Wrap AGOL_DATA_COLLECTION_PLAN_FIELD
html = re.sub(
    r'const AGOL_DATA_COLLECTION_PLAN_FIELD = \"([^\"]+)\";',
    r'const AGOL_DATA_COLLECTION_PLAN_FIELD = SDP_CONFIG.AGOL_DATA_COLLECTION_PLAN_FIELD || \"\1\";',
    html
)

# Wrap AGOL_DATA_COLLECTION_POINT_BUFFER_M (numeric; \?\? guards against 0 override)
html = re.sub(
    r'const AGOL_DATA_COLLECTION_POINT_BUFFER_M = (\d+(?:\.\d+)?);',
    r'const AGOL_DATA_COLLECTION_POINT_BUFFER_M = SDP_CONFIG.AGOL_DATA_COLLECTION_POINT_BUFFER_M ?? \1;',
    html
)

with open('app/web/index.html', 'w') as f:
    f.write(html)
print('  config.js shim applied')
"
  echo "  files synced"
fi

# ---------- 2. Build + push TiTiler image ----------
if [[ "$MODE" == "full" || "$MODE" == "image" ]]; then
  TAG="v$(date +%Y%m%d-%H%M%S)"
  echo "→ Building TiTiler image for linux/amd64 (tag: $TAG)..."
  aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" \
    | docker login --username AWS --password-stdin "254459631110.dkr.ecr.$AWS_REGION.amazonaws.com"
  docker buildx build --platform linux/amd64 \
    -t "$ECR_REPO:$TAG" --push services/titiler
  echo "  pushed $ECR_REPO:$TAG"

  echo "→ Updating ECS task definition..."
  cd "$TF_DIR"
  terraform apply -auto-approve -var "container_image_tag=$TAG" | tail -3
  # Capture the ARN of the task-def revision Terraform just registered. The
  # service has `ignore_changes = [task_definition]` so Terraform won't repoint
  # it on apply — we must hand the new revision to update-service explicitly.
  # `--force-new-deployment` alone redeploys the service's currently-pinned
  # revision (a known footgun: deploys silently re-pull the old image).
  TASK_DEF_ARN="$(terraform output -raw ecs_task_definition_arn)"
  cd - > /dev/null

  echo "→ Deploying task definition $TASK_DEF_ARN ..."
  aws ecs update-service \
    --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
    --task-definition "$TASK_DEF_ARN" \
    --force-new-deployment \
    --profile "$AWS_PROFILE" --region "$AWS_REGION" \
    --query 'service.status' --output text
  echo "→ Waiting for ECS stability (2-3 min; circuit breaker auto-rolls-back on failure)..."
  aws ecs wait services-stable \
    --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
    --profile "$AWS_PROFILE" --region "$AWS_REGION"
  echo "  ECS stable"
fi

# ---------- 3. Generate config.js + sync site to S3 ----------
if [[ "$MODE" == "full" || "$MODE" == "site" ]]; then
  echo "→ Writing config.js..."
  cat > app/web/config.js <<EOF
window.__SDP_CONFIG__ = {
  TITILER: "https://$API_DOMAIN",
  STAC_ROOT: "https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json",
  SITES_QUERY_URL: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/ResearchSites_2026_Public_View/FeatureServer/14/query",
  AGOL_CLIENT_ID: "$AGOL_CLIENT_ID",
  AGOL_PRIVATE_SITES_URL: "$AGOL_PRIVATE_SITES_URL",
  AGOL_RESEARCHER_FIELD: "$AGOL_RESEARCHER_FIELD",
  AGOL_DATA_COLLECTION_URLS: {
    point:   "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Point_Collection_2026/FeatureServer/0",
    line:    "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Line_Collection_2026/FeatureServer/0",
    polygon: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/Polygon_Collection_2026/FeatureServer/0",
  },
  AGOL_DATA_COLLECTION_PLAN_FIELD: "Research_Plan",
  AGOL_DATA_COLLECTION_POINT_BUFFER_M: 1,
};
EOF

  echo "→ Syncing app/web → s3://$SITE_BUCKET..."
  aws s3 sync app/web "s3://$SITE_BUCKET" --delete \
    --exclude "config.example.js" --profile "$AWS_PROFILE"

  echo "→ Invalidating CloudFront..."
  aws cloudfront create-invalidation \
    --distribution-id "$SITE_DIST" --paths "/*" \
    --profile "$AWS_PROFILE" --query 'Invalidation.Status' --output text
  aws cloudfront create-invalidation \
    --distribution-id "$API_DIST" --paths "/*" \
    --profile "$AWS_PROFILE" --query 'Invalidation.Status' --output text
  echo "  invalidations submitted"
fi

echo "=== Deploy complete ==="
echo "  Site: https://sdpbrowser.org"
echo "  API:  https://api.sdpbrowser.org"
