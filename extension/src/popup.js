const DASHBOARD_EVENTS_KEY = "dashboardEvents";
const SEVERITIES = ["critical", "high", "medium", "low", "none"];
const HEATMAP_CATEGORIES = ["PII", "Credentials", "Business Sensitive", "Legal Agreements", "Financial Forecasts", "Internal Strategy"];

const SUPPORTED_HOSTS = ["chatgpt.com", "chat.openai.com", "claude.ai"];
const PAUSE_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let dashboardEvents = [];
let protection = PreflightProtection.normalize(null);
let currentHost = "";

document.addEventListener("DOMContentLoaded", async () => {
  const result = await chrome.storage.local.get([DASHBOARD_EVENTS_KEY, "companyKeywords", PreflightProtection.KEY]);
  dashboardEvents = Array.isArray(result[DASHBOARD_EVENTS_KEY])
    ? result[DASHBOARD_EVENTS_KEY]
    : [];
  protection = PreflightProtection.normalize(result[PreflightProtection.KEY]);
  currentHost = await activeSupportedHost();

  renderProtection();
  renderDashboard(dashboardEvents);
  document.getElementById("keywords-input").value = (result.companyKeywords || []).join("\n");

  const dashboardButton = document.getElementById("open-dashboard");
  if (PREFLIGHT_CONFIG.DASHBOARD_URL) {
    dashboardButton.addEventListener("click", () => chrome.tabs.create({ url: PREFLIGHT_CONFIG.DASHBOARD_URL }));
  }
  document.getElementById("plans-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: `${PREFLIGHT_CONFIG.WEBSITE_URL}#plans` });
  });
  document.getElementById("protection-toggle").addEventListener("change", (event) => {
    saveProtection({ ...protection, enabled: event.target.checked, pausedUntil: 0 });
  });
  document.getElementById("pause-btn").addEventListener("click", () => {
    const paused = PreflightProtection.isPaused(protection);
    saveProtection({ ...protection, pausedUntil: paused ? 0 : Date.now() + PAUSE_MS });
  });
  document.getElementById("site-toggle").addEventListener("change", (event) => {
    const others = protection.disabledSites.filter((site) => site !== currentHost);
    saveProtection({ ...protection, disabledSites: event.target.checked ? others : [...others, currentHost] });
  });
  document.getElementById("export-csv").addEventListener("click", () => exportCsv(dashboardEvents));
  document.getElementById("export-json").addEventListener("click", () => exportJson(dashboardEvents));
  document.getElementById("save-keywords-btn").addEventListener("click", saveKeywords);
  document.getElementById("connect-btn").addEventListener("click", connectAccount);
  document.getElementById("disconnect-btn").addEventListener("click", disconnectAccount);
  document.getElementById("clear-history-btn").addEventListener("click", clearHistory);

  renderAccount(await sendMessage({ type: "PREFLIGHT_GET_STATUS" }));
});

// Hostname of the active tab when it is a supported AI site. Opening the
// popup grants activeTab, which is what makes tab.url readable here.
async function activeSupportedHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab && tab.url ? new URL(tab.url).hostname : "";
    return SUPPORTED_HOSTS.includes(host) ? host : "";
  } catch (err) {
    return "";
  }
}

async function saveProtection(next) {
  protection = PreflightProtection.normalize(next);
  await chrome.storage.local.set({ [PreflightProtection.KEY]: protection });
  renderProtection();
}

function renderProtection() {
  const paused = protection.enabled && PreflightProtection.isPaused(protection);
  const siteOff = Boolean(currentHost) && protection.disabledSites.includes(currentHost);
  const active = protection.enabled && !paused;

  document.querySelector(".protection").classList.toggle("off", !active);
  document.getElementById("protection-toggle").checked = protection.enabled;

  let title = "Protection is on";
  let detail = "Checking prompts on ChatGPT and Claude.";
  if (!protection.enabled) {
    title = "Protection is off";
    detail = "Nothing is checked until you turn it back on.";
  } else if (paused) {
    const until = new Date(protection.pausedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    title = "Protection is paused";
    detail = `Checks resume at ${until}.`;
  } else if (protection.disabledSites.length > 0) {
    detail = `Checking prompts, except on ${protection.disabledSites.join(", ")}.`;
  }
  setText("protection-title", title);
  setText("protection-detail", detail);

  const pauseButton = document.getElementById("pause-btn");
  pauseButton.disabled = !protection.enabled;
  pauseButton.textContent = paused ? "Resume now" : "Pause for 1 hour";

  document.getElementById("site-row").hidden = !currentHost;
  document.getElementById("site-toggle").checked = !siteOff;
  setText("site-name", currentHost);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(response || { success: false, error: "no_response" });
    });
  });
}

function renderAccount(status) {
  const account = status && status.account;
  const badge = document.getElementById("mode-badge");
  const detail = document.getElementById("mode-detail");
  const apiConfigured = Boolean(status && status.apiConfigured);

  document.getElementById("business-connect").hidden = !apiConfigured || Boolean(account);
  document.getElementById("business-connected").hidden = !account;
  document.getElementById("open-dashboard").hidden = !account || !PREFLIGHT_CONFIG.DASHBOARD_URL;
  // Keywords, full history, charts and exports are Enterprise features.
  document.getElementById("enterprise").hidden = !account;
  document.getElementById("upsell").hidden = Boolean(account);

  if (account) {
    badge.textContent = `Enterprise · ${labelize(account.plan || "connected")}`;
    badge.classList.add("business");
    detail.textContent = account.layer2Enabled
      ? "Pattern checks run in your browser. Prompts that pass are also checked by your company's Preflight server. Your admin sees detection counts and types, never prompt text."
      : "All checks run in your browser. Your admin sees detection counts and types, never prompt text.";
  } else {
    badge.textContent = "Free · on-device";
    badge.classList.remove("business");
    detail.textContent = "All checks run in your browser. Nothing you type is sent to Preflight.";
  }
}

async function connectAccount() {
  const input = document.getElementById("token-input");
  const message = document.getElementById("connect-msg");
  message.classList.remove("error");
  message.textContent = "Connecting…";
  const response = await sendMessage({ type: "PREFLIGHT_CONNECT", token: input.value });
  if (!response.success) {
    message.classList.add("error");
    message.textContent = response.error || "Could not connect.";
    return;
  }
  input.value = "";
  message.textContent = "";
  renderAccount(await sendMessage({ type: "PREFLIGHT_GET_STATUS" }));
}

async function disconnectAccount() {
  await sendMessage({ type: "PREFLIGHT_DISCONNECT" });
  renderAccount(await sendMessage({ type: "PREFLIGHT_GET_STATUS" }));
}

async function saveKeywords() {
  const keywords = document.getElementById("keywords-input").value
    .split("\n")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const unique = [...new Set(keywords)].slice(0, 200);
  await chrome.storage.local.set({ companyKeywords: unique });
  setText("keywords-msg", `Saved ${unique.length} keyword${unique.length === 1 ? "" : "s"}.`);
}

async function clearHistory() {
  if (!window.confirm("Delete all scan history stored on this device?")) return;
  await chrome.storage.local.set({ [DASHBOARD_EVENTS_KEY]: [] });
  dashboardEvents = [];
  renderDashboard(dashboardEvents);
}

// The first event logged for each prompt. Follow-up events (proceeded,
// cancelled, replaced) repeat the same findings and would double count.
function isScanEvent(event) {
  const action = String(event.action || "");
  return action === "layer1_warning_shown"
    || action === "layer1_clean_allowed"
    || action.startsWith("layer2_verdict_")
    || (action.startsWith("layer2_") && action.endsWith("_allowed"));
}

function isWarningEvent(event) {
  const action = String(event.action || "");
  return action === "layer1_warning_shown" || /^layer2_verdict_(medium|high|critical)$/.test(action);
}

function renderDashboard(events) {
  const scans = events.filter(isScanEvent);
  const weekScans = scans.filter((event) => event.timestamp >= Date.now() - WEEK_MS);

  setText("week-scans", weekScans.length);
  setText("week-catches", weekScans.filter(isWarningEvent).length);

  setText("total-scans", scans.length);
  setText("layer1-count", sum(scans, "layer1_detections_count"));
  setText("layer2-count", sum(scans, "layer2_detections_count"));
  setText("pending-count", scans.filter(isWarningEvent).length);

  renderBars("severity-bars", countBy(scans, (event) => event.severity || "none"), SEVERITIES);
  renderBars("category-bars", categoryCounts(scans));
  renderTimeline(scans);
  renderHeatmap(scans);
  renderTable(events.slice(0, 3));
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value);
}

function sum(events, field) {
  return events.reduce((total, event) => total + Number(event[field] || 0), 0);
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function categoryCounts(events) {
  return events.reduce((counts, event) => {
    const categories = Array.isArray(event.categories) && event.categories.length > 0
      ? event.categories
      : ["Uncategorized"];
    categories.forEach((category) => {
      counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  }, {});
}

function renderBars(containerId, counts, preferredOrder = null) {
  const container = document.getElementById(containerId);
  const entries = (preferredOrder || Object.keys(counts).sort())
    .map((key) => [key, counts[key] || 0])
    .filter(([, value]) => value > 0 || preferredOrder);
  const max = Math.max(1, ...entries.map(([, value]) => value));

  container.innerHTML = entries.length
    ? entries.map(([key, value]) => `
      <div class="bar-row">
        <span title="${escapeHtml(labelize(key))}">${escapeHtml(labelize(key))}</span>
        <span class="track"><span class="fill ${escapeHtml(key)}" style="width: ${(value / max) * 100}%"></span></span>
        <strong>${value}</strong>
      </div>
    `).join("")
    : '<p class="empty">No detections yet.</p>';
}

function renderTimeline(events) {
  const container = document.getElementById("timeline");
  const days = [];
  const now = new Date();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    day.setHours(0, 0, 0, 0);
    days.push(day);
  }

  const counts = days.map((day) => {
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    return events.filter((event) => event.timestamp >= day.getTime() && event.timestamp < next.getTime()).length;
  });
  const max = Math.max(1, ...counts);

  container.innerHTML = days.map((day, index) => {
    const value = counts[index];
    return `
      <div class="day" title="${value} scans">
        <span class="day-bar" style="height: ${Math.max(3, (value / max) * 92)}px"></span>
        <span>${day.toLocaleDateString(undefined, { weekday: "short" })}</span>
      </div>
    `;
  }).join("");
}

function renderHeatmap(events) {
  const container = document.getElementById("heatmap");
  const columns = ["Layer 1", "Layer 2", "High+", "Total"];
  const counts = HEATMAP_CATEGORIES.map((category) => {
    const related = events.filter((event) => (event.categories || []).includes(category));
    return {
      category,
      layer1: related.reduce((total, event) => total + Number(event.layer1_detections_count || 0), 0),
      layer2: related.reduce((total, event) => total + Number(event.layer2_detections_count || 0), 0),
      high: related.filter((event) => ["critical", "high"].includes(event.severity)).length,
      total: related.length,
    };
  }).filter((row) => row.total > 0);

  container.innerHTML = [
    '<span></span>',
    ...columns.map((column) => `<span class="heat-label">${column}</span>`),
    ...(counts.length ? counts.flatMap((row) => [
      `<span class="heat-label" title="${escapeHtml(row.category)}">${escapeHtml(row.category)}</span>`,
      heatCell(row.layer1, "l1"),
      heatCell(row.layer2, "l2"),
      heatCell(row.high, row.high > 0 ? "hot" : ""),
      heatCell(row.total, row.total > 2 ? "hot" : ""),
    ]) : ['<span class="empty" style="grid-column: 1 / -1;">No heatmap data yet.</span>']),
  ].join("");
}

function heatCell(value, className) {
  return `<span class="heat-cell ${className}">${value}</span>`;
}

function renderTable(events) {
  const table = document.getElementById("events-table");
  const empty = document.getElementById("empty-state");
  empty.hidden = events.length > 0;

  table.innerHTML = events.map((event) => {
    const categories = Array.isArray(event.categories) && event.categories.length > 0
      ? event.categories.join(", ")
      : "Uncategorized";
    const status = event.decision || labelize(event.action || "unknown");

    return `
      <tr>
        <td title="${formatTime(event.timestamp)}">${formatTime(event.timestamp)}</td>
        <td><span class="severity ${escapeHtml(event.severity || "none")}">${escapeHtml(labelize(event.severity || "none"))}</span></td>
        <td title="${escapeHtml(categories)}">${escapeHtml(categories)}</td>
        <td title="${escapeHtml(status)}">${escapeHtml(status)}</td>
      </tr>
    `;
  }).join("");
}

function exportCsv(events) {
  const headers = [
    "id", "timestamp", "site", "stage", "severity", "categories",
    "layer1_detections_count", "layer2_detections_count", "decision", "action_taken",
  ];
  const rows = events.map((event) => headers.map((header) => {
    const value = header === "categories" ? (event.categories || []).join("|") : event[header];
    return csvCell(value ?? "");
  }).join(","));
  download(`preflight-dashboard-${Date.now()}.csv`, [headers.join(","), ...rows].join("\n"), "text/csv");
}

function exportJson(events) {
  download(`preflight-dashboard-${Date.now()}.json`, JSON.stringify(events, null, 2), "application/json");
}

function download(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  if (chrome.downloads?.download) {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function formatTime(timestamp) {
  if (!timestamp) return "Unknown";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function labelize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span.innerHTML;
}
