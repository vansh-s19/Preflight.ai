// Minimal stand-in for the extension APIs, so the real content script and
// popup can render outside Chrome for store screenshots. Free plan, a few
// catches this week, nothing connected. Not shipped in the extension.
(function () {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const scan = (hoursAgo, warned) => ({
    action: warned ? "layer1_warning_shown" : "layer1_clean_allowed",
    timestamp: now - hoursAgo * hour,
    severity: warned ? "critical" : "none",
  });
  const store = {
    dashboardEvents: [
      scan(1, true), scan(3, false), scan(5, false), scan(26, true), scan(30, false),
      scan(49, false), scan(52, true), scan(75, false), scan(98, false), scan(120, false),
    ],
  };

  const pick = (keys) => Object.fromEntries((keys || []).filter((key) => key in store).map((key) => [key, store[key]]));

  window.chrome = {
    runtime: {
      id: "store-preview",
      lastError: undefined,
      getURL: (path) => `../../extension/${path}`,
      sendMessage: (message, callback) => {
        const response = message.type === "PREFLIGHT_LAYER2_CLASSIFY"
          ? { success: false, error: "layer2_disabled" }
          : message.type === "PREFLIGHT_GET_STATUS"
            ? { success: true, apiConfigured: false, account: null }
            : { success: true };
        if (callback) setTimeout(() => callback(response), 0);
      },
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const result = pick(keys);
          if (callback) { callback(result); return undefined; }
          return Promise.resolve(result);
        },
        set: async (values) => { Object.assign(store, values); },
      },
      session: { get: async () => ({}) },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://claude.ai/new" }],
      create: () => {},
    },
  };
})();
