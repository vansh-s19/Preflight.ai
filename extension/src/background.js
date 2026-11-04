/**
 * background.js
 * Service worker — handles all network communication so content
 * scripts never talk to the backend API directly.
 *
 * Two modes:
 *  - Individual (default): no account. Layer 1 runs locally, events are kept
 *    only in chrome.storage.local, and nothing is sent anywhere.
 *  - Business: the user connects a company access token from the popup.
 *    Layer 2 classification (if the org's plan includes it) and privacy-safe
 *    scan metadata are sent to PREFLIGHT_CONFIG.API_BASE_URL.
 */

importScripts("config.js", "protection.js");

const DASHBOARD_EVENTS_KEY = "dashboardEvents";
const PENDING_TELEMETRY_KEY = "pendingTelemetryEvents";
const ACCOUNT_KEY = "account"; // { token, orgId, plan, layer2Enabled }
const MAX_DASHBOARD_EVENTS = 500;
const MAX_PENDING_TELEMETRY = 200;
const FLUSH_ALARM = "preflight-flush-queue";

const LAYER1_BUSINESS_TYPES = new Set(["company_keyword", "file_reference", "source_code"]);

function apiConfigured() {
  return typeof PREFLIGHT_CONFIG.API_BASE_URL === "string" && PREFLIGHT_CONFIG.API_BASE_URL.length > 0;
}

async function getAccount() {
  if (!apiConfigured()) return null;
  const { [ACCOUNT_KEY]: account = null } = await chrome.storage.local.get([ACCOUNT_KEY]);
  return account && account.token ? account : null;
}

function severityRank(level) {
  return { critical: 4, high: 3, medium: 2, low: 1, none: 0 }[level] || 0;
}

function highestSeverity(findings, layer2) {
  const layer1Severity = findings.reduce((highest, finding) => (
    severityRank(finding.riskLevel) > severityRank(highest) ? finding.riskLevel : highest
  ), "none");
  const layer2Severity = layer2?.risk_level || "none";
  return severityRank(layer2Severity) > severityRank(layer1Severity)
    ? layer2Severity
    : layer1Severity;
}

function categoryForLayer1Type(type) {
  const value = typeof type === "string" ? type : "unknown";
  if (value.includes("key") || value.includes("secret") || value.includes("password") || value === "jwt" || value === "db_url" || value === "private_key" || value === "env_content") {
    return "Credentials";
  }
  if (LAYER1_BUSINESS_TYPES.has(value)) return "Business Sensitive";
  return "PII";
}

function categoryForLayer2Type(type) {
  return ({
    contract: "Legal Agreements",
    financial_report: "Financial Forecasts",
    strategy_doc: "Internal Strategy",
    hr_doc: "Internal Documents",
    source_code: "Internal Documents",
    customer_data: "Internal Documents",
    general: "General",
  })[type] || "Sensitive Business";
}

function normalizeDashboardEvent(payload) {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const layer2 = payload.layer2 || null;
  const layer1Count = findings.length;
  const layer2Count = layer2 && layer2.content_type !== "general" ? 1 : 0;
  const categories = [
    ...findings.map((finding) => categoryForLayer1Type(finding.type)),
    ...(layer2Count ? [categoryForLayer2Type(layer2.content_type)] : []),
  ];

  return {
    id: `${payload.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: payload.timestamp || Date.now(),
    site: payload.site || "unknown",
    stage: payload.stage || "unknown",
    action: payload.action || "unknown",
    textLength: payload.textLength || 0,
    layer1_detections_count: layer1Count,
    layer2_detections_count: layer2Count,
    severity: highestSeverity(findings, layer2),
    categories,
    layer1_findings: findings,
    layer2_result: layer2,
    decision: payload.decision ?? null,
    action_taken: payload.action_taken ?? null,
  };
}

// Only metadata leaves the browser: finding types, severity, the action the
// user chose, and timing. Never prompt text, previews, or matched values.
function telemetryPayloadFromLog(payload) {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const layer2 = payload.layer2 || null;
  const layer1Detections = findings.map((finding) => finding.type).filter(Boolean);
  const layer2Detections = layer2 && layer2.content_type && layer2.content_type !== "general"
    ? [layer2.content_type]
    : [];

  return {
    timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
    input_preview: "",
    layer1_detections: layer1Detections,
    layer2_detections: layer2Detections,
    severity: highestSeverity(findings, layer2),
    decision: payload.decision ?? null,
    action_taken: payload.action_taken ?? payload.action ?? null,
    latency_ms: Number(payload.latency_ms || 0),
    source: "chrome_extension",
    extension_version: chrome.runtime.getManifest().version,
    browser_type: detectBrowserName(),
    ai_platform: payload.ai_platform || payload.site || "unknown",
    domain: payload.domain || "unknown",
    page_title: "",
    input_source: payload.input_source || "text_field",
    user_id: null,
    device_id: null,
    organization_id: null,
  };
}

function detectBrowserName() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("brave")) return "brave";
  return "chrome";
}

async function storeDashboardEvent(payload) {
  const event = normalizeDashboardEvent(payload);
  const { [DASHBOARD_EVENTS_KEY]: dashboardEvents = [] } = await chrome.storage.local.get([DASHBOARD_EVENTS_KEY]);
  dashboardEvents.unshift(event);
  await chrome.storage.local.set({
    [DASHBOARD_EVENTS_KEY]: dashboardEvents.slice(0, MAX_DASHBOARD_EVENTS),
  });
}

async function apiFetch(path, token, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    return await fetch(`${PREFLIGHT_CONFIG.API_BASE_URL}${path}`, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------
// Layer 2 client — POST /classify (business accounts only)
// ---------------------------------------------------------------------
async function callLayer2Classify(text) {
  const account = await getAccount();
  if (!account || !account.layer2Enabled) return { success: false, error: "layer2_disabled" };

  try {
    const response = await apiFetch("/classify", account.token, {
      method: "POST",
      body: { text },
      timeoutMs: PREFLIGHT_CONFIG.LAYER2_TIMEOUT_MS,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { success: false, error: `HTTP ${response.status}: ${body.detail || "unknown error"}` };
    }
    return { success: true, result: await response.json() };
  } catch (err) {
    return { success: false, error: err.name === "AbortError" ? "timeout" : "unavailable" };
  }
}

// ---------------------------------------------------------------------
// Account linking — verifies the token against GET /config
// ---------------------------------------------------------------------
async function connectAccount(token) {
  if (!apiConfigured()) return { success: false, error: "This build has no business server configured." };
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return { success: false, error: "Enter an access token." };

  try {
    const response = await apiFetch("/config", trimmed);
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: "That access token was not recognised." };
    }
    if (!response.ok) return { success: false, error: `Server error (HTTP ${response.status}).` };
    const config = await response.json();
    const account = {
      token: trimmed,
      orgId: config.org_id,
      plan: config.plan,
      layer2Enabled: Boolean(config.layer2_enabled),
    };
    await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
    return { success: true, account: publicAccount(account) };
  } catch (err) {
    return { success: false, error: "Could not reach the Preflight server." };
  }
}

function publicAccount(account) {
  return account ? { orgId: account.orgId, plan: account.plan, layer2Enabled: account.layer2Enabled } : null;
}

async function disconnectAccount() {
  await chrome.storage.local.remove([ACCOUNT_KEY, PENDING_TELEMETRY_KEY]);
  return { success: true };
}

// ---------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------
const HANDLERS = {
  SENTINEL_LOG_EVENT: (message) => handleLogEvent(message.payload || {}),
  PREFLIGHT_LAYER2_CLASSIFY: (message) => {
    if (typeof message.text !== "string" || message.text.trim().length === 0) {
      return Promise.resolve({ success: false, error: "invalid_request" });
    }
    return callLayer2Classify(message.text);
  },
  PREFLIGHT_GET_STATUS: async () => ({
    success: true,
    apiConfigured: apiConfigured(),
    account: publicAccount(await getAccount()),
  }),
  PREFLIGHT_CONNECT: (message) => connectAccount(message.token),
  PREFLIGHT_DISCONNECT: () => disconnectAccount(),
  PREFLIGHT_SITE_HEALTH: (message, sender) => setTabHealth(sender.tab?.id, message.status),
  PREFLIGHT_LOAD_PARSER: (message, sender) => loadParser(message.parser, sender),
};

// ---------------------------------------------------------------------
// Attachment parsers, injected into the asking frame's content-script
// world on first use instead of loading on every page (see fileScanner.js).
// ---------------------------------------------------------------------
const PARSER_FILES = {
  pdf: "src/vendor/pdf.min.js",
  docx: "src/vendor/mammoth.browser.min.js",
};

async function loadParser(parser, sender) {
  const file = Object.hasOwn(PARSER_FILES, parser) ? PARSER_FILES[parser] : null;
  const tabId = sender.tab?.id;
  if (!file || !Number.isInteger(tabId)) return { success: false, error: "invalid_request" };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [sender.frameId ?? 0] },
      files: [file],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || "inject_failed" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ success: false, error: err?.message || "handler_error" }));
  // Keep the channel open for the async response.
  return true;
});

async function handleLogEvent(payload) {
  // Post-send confirmations are noise for the local history.
  if (payload.stage === "post_send_confirmed") return { success: true };

  await storeDashboardEvent(payload);

  const account = await getAccount();
  if (!account) return { success: true }; // individual mode: local only

  const telemetryPayload = telemetryPayloadFromLog(payload);
  const sent = await sendTelemetry(telemetryPayload, account.token);
  if (!sent) await queueTelemetry(telemetryPayload);
  return { success: true };
}

async function sendTelemetry(payload, token) {
  try {
    const response = await apiFetch("/api/scan-event", token, { method: "POST", body: payload });
    return response.ok;
  } catch (err) {
    return false;
  }
}

async function queueTelemetry(payload) {
  const { [PENDING_TELEMETRY_KEY]: pendingTelemetry = [] } = await chrome.storage.local.get([PENDING_TELEMETRY_KEY]);
  pendingTelemetry.push(payload);
  await chrome.storage.local.set({
    [PENDING_TELEMETRY_KEY]: pendingTelemetry.slice(-MAX_PENDING_TELEMETRY),
  });
}

async function flushTelemetryQueue() {
  const account = await getAccount();
  if (!account) return;
  const { [PENDING_TELEMETRY_KEY]: pendingTelemetry = [] } = await chrome.storage.local.get([PENDING_TELEMETRY_KEY]);
  if (!pendingTelemetry.length) return;

  const stillPending = [];
  for (const payload of pendingTelemetry) {
    const sent = await sendTelemetry(payload, account.token);
    if (!sent) stillPending.push(payload);
  }
  await chrome.storage.local.set({ [PENDING_TELEMETRY_KEY]: stillPending.slice(-MAX_PENDING_TELEMETRY) });
}

// Periodically flush any queued events once back online. Alarms can be
// cleared on browser restart, so re-create it whenever the worker starts.
chrome.alarms.get(FLUSH_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 5 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flushTelemetryQueue();
  if (alarm.name === RESUME_ALARM) updateBadge();
});

// ---------------------------------------------------------------------
// First run: show the welcome page once (not on updates). On uninstall,
// Chrome opens the website's feedback page; no data is attached to the URL.
// ---------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
});
if (PREFLIGHT_CONFIG.WEBSITE_URL) chrome.runtime.setUninstallURL(`${PREFLIGHT_CONFIG.WEBSITE_URL}uninstall.html`);

// ---------------------------------------------------------------------
// Toolbar badge: "OFF" while protection is switched off or paused. An
// alarm clears it when a pause runs out; the content script checks the
// pause end time itself, so protection resumes even if the alarm is late.
// ---------------------------------------------------------------------
const RESUME_ALARM = "preflight-resume";

async function updateBadge() {
  const { [PreflightProtection.KEY]: stored } = await chrome.storage.local.get([PreflightProtection.KEY]);
  const settings = PreflightProtection.normalize(stored);
  const paused = settings.enabled && PreflightProtection.isPaused(settings);
  const off = !settings.enabled || paused;

  await chrome.action.setBadgeText({ text: off ? "OFF" : "" });
  if (off) await chrome.action.setBadgeBackgroundColor({ color: "#647084" });
  if (paused) chrome.alarms.create(RESUME_ALARM, { when: settings.pausedUntil });
  else chrome.alarms.clear(RESUME_ALARM);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PreflightProtection.KEY]) updateBadge();
});
updateBadge();

// ---------------------------------------------------------------------
// Per-tab warning when the content script can't find the site's composer
// (see checkHealth in content.js). A tab's badge overrides the global one;
// null hands the tab back to the global "OFF"/blank badge. Statuses are
// kept in session storage so the popup can explain the warning.
// ---------------------------------------------------------------------
const TAB_HEALTH_KEY = "tabHealth";
const HEALTH_STATUSES = new Set(["ok", "broken", "unknown"]);

async function setTabHealth(tabId, status) {
  if (!Number.isInteger(tabId) || !HEALTH_STATUSES.has(status)) return { success: false, error: "invalid_request" };
  const broken = status === "broken";

  await chrome.action.setBadgeText({ tabId, text: broken ? "!" : null });
  if (broken) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c2410c" });
  await chrome.action.setTitle({
    tabId,
    title: broken ? "Preflight.ai: can't find the message box on this page. Checks may not run." : "Preflight.ai",
  });

  const { [TAB_HEALTH_KEY]: health = {} } = await chrome.storage.session.get([TAB_HEALTH_KEY]);
  if (broken) health[tabId] = status;
  else delete health[tabId];
  await chrome.storage.session.set({ [TAB_HEALTH_KEY]: health });
  return { success: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [TAB_HEALTH_KEY]: health = {} } = await chrome.storage.session.get([TAB_HEALTH_KEY]);
  if (!(tabId in health)) return;
  delete health[tabId];
  await chrome.storage.session.set({ [TAB_HEALTH_KEY]: health });
});
