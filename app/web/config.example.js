// Runtime configuration for the SDP Browser production app.
//
// This file is loaded before the module script in index.html and exposes
// `window.__SDP_CONFIG__`. All keys are optional; omit one to fall back to
// the built-in default (local-dev-friendly values).
//
// At deploy time the GitHub Actions workflow emits the real config.js
// alongside the static bundle using Terraform outputs, e.g.:
//
//   window.__SDP_CONFIG__ = {
//     TITILER: "https://d1abc123.cloudfront.net",
//     STAC_ROOT: "https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json",
//     SITES_QUERY_URL: "https://services8.arcgis.com/.../FeatureServer/14/query",
//     AGOL_CLIENT_ID: "<browser-app-client-id>",
//     AGOL_PRIVATE_SITES_URL: "https://services8.arcgis.com/.../ResearchSites_2026/FeatureServer/14",
//     AGOL_RESEARCHER_FIELD: "Researcher",
//   };
//
// Copy this file to config.js for local testing against the prod layout.

window.__SDP_CONFIG__ = {
  // Base URL of the TiTiler tile server. No trailing slash.
  TITILER: "http://localhost:8000",

  // Root STAC catalog JSON. Items are walked lazily from here on first load.
  STAC_ROOT: "https://rmbl-sdp.s3.us-east-2.amazonaws.com/stac/v1/catalog.json",

  // Optional ArcGIS FeatureServer query endpoint for research-site overlays.
  SITES_QUERY_URL: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/ResearchSites_2026_Public_View/FeatureServer/14/query",

  // ArcGIS Online OAuth (PKCE) for the authenticated "My research sites"
  // overlay. The AGOL app must be registered as a "Browser" application and
  // list <origin>/oauth-callback.html in its redirect URIs.
  AGOL_CLIENT_ID: "73IpknmLfeXEBLAf",
  AGOL_PRIVATE_SITES_URL: "https://services8.arcgis.com/jOS5YDdMN6EQxI1b/arcgis/rest/services/ResearchSites_2026/FeatureServer/14",
  AGOL_RESEARCHER_FIELD: "Researcher",
};
