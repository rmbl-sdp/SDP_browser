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
TF_DIR="infra/envs/staging"
MODE="${1:-full}"

cd "$(dirname "$0")/.."

echo "=== SDP Browser staging deploy (mode: $MODE) ==="

# ---------- 1. Sync prototype → app (config shim) ----------
if [[ "$MODE" == "full" || "$MODE" == "site" ]]; then
  echo "→ Syncing prototype/web → app/web..."
  cp prototype/web/js/catalog-static.js app/web/js/catalog-static.js
  cp prototype/web/js/idb.js app/web/js/idb.js
  cp prototype/web/catalog.json app/web/catalog.json
  cp prototype/web/rmbl-logo.png app/web/rmbl-logo.png

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
  cd - > /dev/null

  echo "→ Forcing new ECS deployment..."
  aws ecs update-service \
    --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
    --force-new-deployment \
    --profile "$AWS_PROFILE" --region "$AWS_REGION" \
    --query 'service.status' --output text
  echo "→ Waiting for ECS stability (2-3 min)..."
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
