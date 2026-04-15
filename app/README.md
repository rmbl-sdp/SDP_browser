# SDP Browser — production web app

The static SPA that ships to S3 + CloudFront. Today it is a near-verbatim copy of [`../prototype/web/`](../prototype/) with one structural change: the tile-server / STAC / ArcGIS endpoints come from a runtime `config.js` instead of being hardcoded, so the same bundle can be deployed to staging and prod.

## Relationship to the rest of the repo

- [`../prototype/web/`](../prototype/) is the sandbox where new features are built first.
- This directory is the promoted copy — ported by hand until we pick up a bundler (Vite / TypeScript). The duplication is explicit and called out in `../SPEC.md §3`.
- [`../services/titiler/`](../services/titiler/) ships the tile server Docker image that this frontend talks to.
- [`../infra/`](../infra/) provisions the S3 bucket, the CloudFront distribution, and all of the AWS plumbing; deployment is driven by [`../.github/workflows/`](../.github/workflows/).

## Runtime config

`web/index.html` pulls three values from `window.__SDP_CONFIG__`:

```js
window.__SDP_CONFIG__ = {
  TITILER:         "https://<cloudfront-api>",             // tile server base URL
  STAC_ROOT:       "https://…/stac/v1/catalog.json",
  SITES_QUERY_URL: "https://services8.arcgis.com/…/FeatureServer/14/query",
};
```

- The canonical shape lives in committed `web/config.example.js`.
- `web/config.js` is **gitignored** and produced per-environment by the deploy workflow (it pulls the CloudFront API hostname out of Terraform outputs — see `deploy-staging.yml` step "Emit runtime config.js").
- If `config.js` is missing or a key isn't set, the app falls back to the same local-dev defaults the prototype uses (`http://localhost:8000` etc.), which makes both the app and the prototype work interchangeably during local testing.

## Local smoke-test (without Docker)

Confirms the prod shape against a local TiTiler:

```bash
# 1. Start TiTiler from services/titiler/.
docker build -t sdp-titiler ../services/titiler
docker run --rm -p 8000:8000 sdp-titiler

# 2. Point the app at it and serve the static bundle.
cp web/config.example.js web/config.js
python3 -m http.server 8080 --directory web
# → http://localhost:8080
```

This is the same experience the prototype gives you, just through the `config.js` path that production uses.

## Deployment

GitHub Actions takes over from here:

- `main` branch → **deploy-staging** workflow syncs `app/web/` to the staging S3 bucket, writes the staging `config.js`, and invalidates CloudFront.
- `v*` git tag → **deploy-prod** workflow, gated on a GitHub environment protection rule.

See [`../infra/README.md`](../infra/README.md) for the one-time AWS bootstrap before the first deploy.

## What's intentionally *not* here yet

- A bundler (Vite / webpack) and TypeScript migration.
- Unit tests for the JS modules.
- A service-worker cache or PWA shell.

These are worth revisiting once the app is live and we've seen real traffic. For now, matching the prototype's zero-build shape keeps feature-porting cheap and readable.
