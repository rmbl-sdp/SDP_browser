# SDP Browser — production web app

This is the production frontend that gets deployed to S3 + CloudFront. It shares the user-facing experience with `../prototype/web/` (in fact it started as a verbatim copy) but reads its endpoints from a runtime `config.js` instead of hardcoding `http://localhost:8000`.

- `web/` is a zero-build static site (plain HTML + ES modules). No bundler yet; a future iteration may add Vite + TypeScript, but that's scope-creep for now.
- `web/config.example.js` documents the runtime config shape. Deploys generate the real `web/config.js` from Terraform outputs.
- Local smoke-test: `cp web/config.example.js web/config.js`, then serve `web/` with any static file server (e.g. `python -m http.server 8080`) alongside a local TiTiler on `http://localhost:8000`. This mirrors what production does without running Docker.

The Infrastructure (`../infra/`) pushes this directory as-is to an S3 bucket behind a private CloudFront distribution and emits `config.js` with the right endpoints per environment.

See the top-level `../README.md` for how the prototype, app, services, and infra fit together.
