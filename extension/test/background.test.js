// Checks the personal vs business privacy guarantees of src/background.js
// with a stubbed chrome API and fetch. Run: node extension/test/background.test.js
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const srcDir = join(__dirname, "..", "src");

function loadBackground(apiBaseUrl) {
  const store = {};
  const fetchCalls = [];
  let onMessage = null;
  const storageListeners = [];
  const badge = { text: "", tabs: {} };
  const sessionStore = {};
  const tabRemovedListeners = [];

  const chrome = {
    runtime: {
      id: "test-extension",
      getManifest: () => ({ version: "1.0.0" }),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (values) => {
          const copy = JSON.parse(JSON.stringify(values));
          Object.assign(store, copy);
          const changes = Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, { newValue: v }]));
          storageListeners.forEach((fn) => fn(changes, "local"));
        },
        remove: async (keys) => { keys.forEach((k) => delete store[k]); },
      },
      session: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in sessionStore).map((k) => [k, sessionStore[k]])),
        set: async (values) => { Object.assign(sessionStore, JSON.parse(JSON.stringify(values))); },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        if (tabId === undefined) badge.text = text;
        else badge.tabs[tabId] = text;
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: { onRemoved: { addListener: (fn) => { tabRemovedListeners.push(fn); } } },
    alarms: {
      get: async () => null,
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    if (url.endsWith("/config")) {
      const ok = options.headers.Authorization === "Bearer good-token";
      return { ok, status: ok ? 200 : 401, json: async () => ({ org_id: "org_1", plan: "growth", layer2_enabled: true }) };
    }
    if (url.endsWith("/classify")) {
      return { ok: true, status: 200, json: async () => ({ risk_level: "low", content_type: "general", confidence: 0.9 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }

  const protection = readFileSync(join(srcDir, "protection.js"), "utf8");
  const config = readFileSync(join(srcDir, "config.js"), "utf8")
    .replace(/API_BASE_URL: "[^"]*"/, `API_BASE_URL: ${JSON.stringify(apiBaseUrl)}`);
  const background = readFileSync(join(srcDir, "background.js"), "utf8");
  const context = vm.createContext({
    chrome, fetch, AbortController, setTimeout, clearTimeout, console,
    navigator: { userAgent: "Chrome/130" },
    importScripts: () => { vm.runInContext(config, context); vm.runInContext(protection, context); },
  });
  vm.runInContext(background, context);

  function send(message, sender = { id: "test-extension" }) {
    return new Promise((resolve) => {
      const keepOpen = onMessage(message, sender, resolve);
      if (!keepOpen) resolve(undefined);
    });
  }

  return { store, sessionStore, fetchCalls, send, badge, setStorage: chrome.storage.local.set, tabRemovedListeners };
}

const scanEvent = {
  stage: "pre_send",
  action: "layer1_warning_shown",
  textLength: 42,
  findings: [{ type: "pan", riskLevel: "high" }],
  site: "chatgpt",
  timestamp: Date.now(),
};

(async () => {
  // Personal build: no server configured, nothing leaves the browser.
  {
    const bg = loadBackground("");
    const status = await bg.send({ type: "PREFLIGHT_GET_STATUS" });
    assert.equal(status.apiConfigured, false);
    assert.equal(status.account, null);

    const layer2 = await bg.send({ type: "PREFLIGHT_LAYER2_CLASSIFY", text: "hello" });
    assert.deepEqual({ ...layer2 }, { success: false, error: "layer2_disabled" });

    await bg.send({ type: "SENTINEL_LOG_EVENT", payload: scanEvent });
    assert.equal(bg.store.dashboardEvents.length, 1, "event kept locally");
    assert.equal(bg.fetchCalls.length, 0, "personal mode must not make network requests");

    await bg.send({ type: "SENTINEL_LOG_EVENT", payload: { stage: "post_send_confirmed", action: "response_received" } });
    assert.equal(bg.store.dashboardEvents.length, 1, "post-send confirmations are not stored");

    const foreign = await bg.send({ type: "PREFLIGHT_GET_STATUS" }, { id: "other-extension" });
    assert.equal(foreign, undefined, "messages from other extensions are ignored");
  }

  // Business build, user not connected yet: still personal behaviour.
  {
    const bg = loadBackground("https://api.example.com");
    const layer2 = await bg.send({ type: "PREFLIGHT_LAYER2_CLASSIFY", text: "hello" });
    assert.equal(layer2.error, "layer2_disabled");
    await bg.send({ type: "SENTINEL_LOG_EVENT", payload: scanEvent });
    assert.equal(bg.fetchCalls.length, 0, "unconnected users send nothing");

    const bad = await bg.send({ type: "PREFLIGHT_CONNECT", token: "wrong" });
    assert.equal(bad.success, false);
    assert.equal(bg.store.account, undefined);

    const good = await bg.send({ type: "PREFLIGHT_CONNECT", token: " good-token " });
    assert.equal(good.success, true);
    assert.equal(good.account.token, undefined, "token is never returned to the popup");
    assert.equal(bg.store.account.token, "good-token");

    bg.fetchCalls.length = 0;
    const classified = await bg.send({ type: "PREFLIGHT_LAYER2_CLASSIFY", text: "quarterly plan" });
    assert.equal(classified.success, true);
    assert.equal(bg.fetchCalls[0].url, "https://api.example.com/classify");

    bg.fetchCalls.length = 0;
    await bg.send({ type: "SENTINEL_LOG_EVENT", payload: { ...scanEvent, input_preview: "my PAN is ABCDE1234F", page_title: "Secret chat" } });
    const telemetry = JSON.parse(bg.fetchCalls[0].options.body);
    assert.equal(bg.fetchCalls[0].url, "https://api.example.com/api/scan-event");
    assert.equal(telemetry.input_preview, "", "prompt text never sent");
    assert.equal(telemetry.page_title, "", "page title never sent");
    assert.deepEqual(telemetry.layer1_detections, ["pan"]);

    await bg.send({ type: "PREFLIGHT_DISCONNECT" });
    assert.equal(bg.store.account, undefined);
  }

  // Toolbar badge follows the on/off and pause settings.
  {
    const bg = loadBackground("");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await bg.send({ type: "PREFLIGHT_GET_STATUS" });
    await settle();
    assert.equal(bg.badge.text, "", "no badge while protection is on");

    const setProtection = async (protection) => {
      await bg.setStorage({ protection });
      await settle();
      await settle();
    };

    await setProtection({ enabled: false });
    assert.equal(bg.badge.text, "OFF", "badge shows OFF when switched off");

    await setProtection({ enabled: true, pausedUntil: Date.now() + 60_000 });
    assert.equal(bg.badge.text, "OFF", "badge shows OFF while paused");

    await setProtection({ enabled: true, pausedUntil: Date.now() - 1 });
    assert.equal(bg.badge.text, "", "badge clears once the pause has ended");
  }

  // A tab whose composer can't be found gets its own "!" badge.
  {
    const bg = loadBackground("");
    const tab = { id: "test-extension", tab: { id: 7 } };
    await bg.send({ type: "PREFLIGHT_SITE_HEALTH", status: "broken" }, tab);
    assert.equal(bg.badge.tabs[7], "!", "broken tab is flagged");
    assert.equal(bg.sessionStore.tabHealth["7"], "broken");

    await bg.send({ type: "PREFLIGHT_SITE_HEALTH", status: "ok" }, tab);
    assert.equal(bg.badge.tabs[7], null, "recovered tab falls back to the global badge");
    assert.equal("7" in bg.sessionStore.tabHealth, false);

    const bad = await bg.send({ type: "PREFLIGHT_SITE_HEALTH", status: "<b>" }, tab);
    assert.equal(bad.success, false, "unknown statuses are rejected");

    await bg.send({ type: "PREFLIGHT_SITE_HEALTH", status: "broken" }, tab);
    await bg.tabRemovedListeners[0](7);
    assert.equal("7" in bg.sessionStore.tabHealth, false, "closed tabs are forgotten");
  }

  console.log("background: all tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
