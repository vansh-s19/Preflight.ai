/**
 * config.js
 * Build-time configuration shared by the background worker and the popup.
 *
 * scripts/build.mjs rewrites the values marked "@build" from environment
 * variables. Leaving API_BASE_URL empty produces an individual-only build:
 * every check runs locally and the extension makes no network requests.
 */

// eslint-disable-next-line no-unused-vars
const PREFLIGHT_CONFIG = Object.freeze({
  API_BASE_URL: "", // @build:PREFLIGHT_API_URL
  DASHBOARD_URL: "", // @build:PREFLIGHT_DASHBOARD_URL
  LAYER2_TIMEOUT_MS: 1500,
  // Marketing site; the popup links to its #plans section.
  WEBSITE_URL: "https://vansh-s19.github.io/Preflight.ai/",
});
