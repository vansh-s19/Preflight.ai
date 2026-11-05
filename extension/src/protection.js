/**
 * protection.js
 * The user's on/off, pause and per-site settings, shared by the content
 * script, the background worker and the popup.
 *
 * Stored in chrome.storage.local under "protection":
 *   { enabled: true, pausedUntil: <epoch ms or 0>, disabledSites: ["claude.ai"] }
 */

// var, not const: after an update this file is injected again into tabs
// that were already open, and redeclaring a const would throw.
// eslint-disable-next-line no-unused-vars, no-var
var PreflightProtection = (() => {
  const KEY = "protection";

  function normalize(value) {
    const settings = value && typeof value === "object" ? value : {};
    return {
      enabled: settings.enabled !== false,
      pausedUntil: Number(settings.pausedUntil) || 0,
      disabledSites: Array.isArray(settings.disabledSites)
        ? settings.disabledSites.filter((site) => typeof site === "string")
        : [],
    };
  }

  function isPaused(settings, now = Date.now()) {
    return settings.pausedUntil > now;
  }

  // False when switched off, paused, or switched off for this hostname.
  function isActive(settings, hostname, now = Date.now()) {
    if (!settings.enabled || isPaused(settings, now)) return false;
    return !hostname || !settings.disabledSites.includes(hostname);
  }

  return Object.freeze({ KEY, normalize, isPaused, isActive });
})();
