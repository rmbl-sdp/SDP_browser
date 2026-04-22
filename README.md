# SDP Browser

Web interface for discovering, exploring, and extracting data from the **RMBL Spatial Data Platform** — a curated STAC catalog of Cloud-Optimized GeoTIFFs for western Colorado research sites. Pairs with the [rSDP](https://rmbl-sdp.github.io/rSDP/) R package: anything the app can preview or download, it can also hand you as copy-pasteable rSDP code.

**Staging**: <https://d2t01u3u0l0v6n.cloudfront.net>

Architecture and deployment strategy live in [`SPEC.md`](./SPEC.md); the short version is a persistent TiTiler on ECS Fargate behind ALB + CloudFront + WAF, a static React-free SPA on S3 + CloudFront, and a client-side walk of the existing static STAC catalog. Lessons and the "don't use Lambda for COG tile servers" decision were carried over from [`bloom_forecast_vis`](https://github.com/rmbl-sdp) and are written up in `SPEC.md §2a`.

## Layout

```
SDP_browser/
├── SPEC.md                ← architecture, phased plan, lessons from bloom_forecast_vis
├── prototype/             ← local-only sandbox, Docker-composed. Fast-iterate UX here.
├── app/                   ← production web app (started as a copy of prototype/web/)
├── services/
│   └── titiler/           ← production TiTiler Docker image (same code as prototype's)
├── infra/                 ← Terraform: modules/, bootstrap/, envs/staging/, envs/prod/
└── .github/workflows/     ← CI + OIDC-authenticated deploys (staging on main, prod on tag v*)
```

### When to touch what

- **Experimenting with the interface or a new feature** → `prototype/` (local, fast, no impact on the deployed app).
- **Ready to ship a vetted feature** → port the change into `app/web/` and `services/titiler/` (they mirror the prototype shape today; duplication is intentional and will shrink once the app picks up a bundler).
- **Changing cloud shape** → `infra/` + the relevant workflow in `.github/workflows/`.

## Quick starts

**Run the sandbox** (full stack, real SDP data, no AWS):

```bash
cd prototype && docker compose up --build
# → http://localhost:8080
```

See [`prototype/README.md`](./prototype/README.md) for a tour of the features and troubleshooting.

**Run the prod app locally** (useful before promoting a change):

```bash
# 1. TiTiler
docker build -t sdp-titiler services/titiler
docker run --rm -p 8000:8000 sdp-titiler

# 2. Serve the static site (anything that serves app/web/ will do)
cp app/web/config.example.js app/web/config.js   # TITILER defaults to localhost:8000
python3 -m http.server 8080 --directory app/web
# → http://localhost:8080
```

**Deploy** — see [`infra/README.md`](./infra/README.md) for the one-time bootstrap, the OIDC trust wiring in GitHub, and the per-env `terraform apply` steps.

## Contribution model

Trunk-based on `main`, short-lived feature branches, PRs reviewed via GitHub.

- Merging to `main` → **CI** runs (`terraform fmt -check`, `validate`, `docker build`) and then **deploy-staging** runs on success. Staging should always reflect `main`.
- Cutting a `vX.Y.Z` tag → **deploy-prod** runs, gated by a GitHub environment protection rule for a reviewer.

Commits are checked by the local pre-commit hook in [`.githooks/`](./.githooks/README.md) — enable it on your clone with `git config core.hooksPath .githooks`.

## Further reading

- [`SPEC.md`](./SPEC.md) — full architecture, cost model, phased roadmap.
- [`prototype/README.md`](./prototype/README.md) — sandbox feature tour.
- [`app/README.md`](./app/README.md) — production frontend notes (runtime config, local smoke-test).
- [`infra/README.md`](./infra/README.md) — Terraform bootstrap, deploy walkthrough.
