/**
 * content.js
 * Runs on chatgpt.com / chat.openai.com / claude.ai
 *
 * Responsibilities:
 *  1. Watch the prompt input box.
 *  2. Intercept Send (click or Enter) BEFORE the request fires.
 *  3. Run Layer 1 detection (local, instant).
 *  4. If Layer 1 flags → show warning overlay, pause send.
 *  5. If Layer 1 is clean → call Layer 2 ML backend (business accounts
 *     only; async, 1.5s timeout).
 *  6. Layer 2 high risk → show warning. Medium risk → show softer warning.
 *     Low risk or Layer 2 unavailable → allow send.
 *  7. Log every decision to the background service worker.
 *  8. After send, observe the response area to confirm the prompt went out.
 */

(function () {
  const SITE = detectAiPlatform(location.hostname);
  let lastInputSource = "text_field";

  // Verbose logging into the host page's console is off by default. To turn
  // it on, run localStorage.setItem("preflightDebug", "1") on the page.
  let debugEnabled = false;
  try { debugEnabled = localStorage.getItem("preflightDebug") === "1"; } catch (err) { /* storage blocked */ }
  function debugLog(...args) {
    if (debugEnabled) console.log(...args);
  }

  function detectAiPlatform(hostname) {
    const host = hostname.toLowerCase();
    if (host.includes("claude.ai")) return "claude";
    return "chatgpt";
  }

  // ---------------------------------------------------------------------
  // Site-specific selectors (this is the part that needs maintenance
  // whenever ChatGPT/Claude update their UI)
  // ---------------------------------------------------------------------
  const SELECTORS = {
    // ChatGPT has shipped both a ProseMirror div (#prompt-textarea) and a
    // plain <textarea name="prompt"> composer; keep every known variant so a
    // UI rollout on one account doesn't silently disable interception.
    chatgpt: {
      inputBox: '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt',
      sendButton: 'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send message" i], button[aria-label="Send prompt" i], form button[type="submit"]',
      responseContainer: 'div[data-message-author-role="assistant"]',
    },
    claude: {
      inputBox: 'div[contenteditable="true"]',
      sendButton: 'button[aria-label="Send message" i]',
      responseContainer: 'div[data-testid="message"]',
    },
  };

  const sel = SELECTORS[SITE];

  window.addEventListener("paste", (event) => {
    lastInputSource = "clipboard";
    if (event.clipboardData && event.clipboardData.files && event.clipboardData.files.length > 0) {
      addAttachments(event.clipboardData.files);
    }
  }, true);
  window.addEventListener("drop", (event) => {
    lastInputSource = "upload";
    if (event.dataTransfer && event.dataTransfer.files) addAttachments(event.dataTransfer.files);
  }, true);
  window.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") {
      lastInputSource = "upload";
      addAttachments(event.target.files);
    }
  }, true);

  // Holds the currently pending send action so we can resume it
  // after the employee responds to the warning.
  let pendingSend = null;

  // Files picked/dropped since the last successful send. The site's own JS
  // may clear the underlying <input type="file"> once it "accepts" the
  // attachment, so we capture File objects immediately on change/drop
  // rather than re-reading the input at send time. Known limitation: if the
  // employee removes an attachment chip in the page UI without us seeing a
  // corresponding DOM event, it stays queued here until the next send.
  let pendingAttachments = [];

  // On/off, pause and per-site settings from the popup. Cached here because
  // handleSendAttempt must decide synchronously whether to intercept.
  // Until storage answers, protection stays on.
  let protection = PreflightProtection.normalize(null);
  try {
    chrome.storage.local.get([PreflightProtection.KEY], (result) => {
      if (!chrome.runtime.lastError) protection = PreflightProtection.normalize(result[PreflightProtection.KEY]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[PreflightProtection.KEY]) {
        protection = PreflightProtection.normalize(changes[PreflightProtection.KEY].newValue);
      }
    });
  } catch (err) { /* extension context invalidated: keep protection on */ }

  function attachmentKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function addAttachments(fileList) {
    if (!fileList || fileList.length === 0) return;
    const seen = new Set(pendingAttachments.map(attachmentKey));
    Array.from(fileList).forEach((file) => {
      const key = attachmentKey(file);
      if (!seen.has(key)) {
        seen.add(key);
        pendingAttachments.push(file);
      }
    });
    if (window.PreflightFileScanner && PreflightProtection.isActive(protection, location.hostname)) {
      window.PreflightFileScanner.preload(fileList);
    }
  }

  // ---------------------------------------------------------------------
  // Helper: get current text from the input box (handles both
  // <textarea> based and contenteditable-based editors)
  // ---------------------------------------------------------------------
  function getInputText(inputEl) {
    if (!inputEl) return "";
    return inputEl.value !== undefined ? inputEl.value : inputEl.innerText;
  }

  function replaceInputText(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();

    if (inputEl.value !== undefined) {
      const prototype = Object.getPrototypeOf(inputEl);
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (valueSetter) valueSetter.call(inputEl, text);
      else inputEl.value = text;
      inputEl.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
      return;
    }

    // execCommand is still the most compatible way to update controlled
    // contenteditable editors such as ProseMirror while producing the input
    // event their framework expects.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    selection.removeAllRanges();

    if (!inserted) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = value;
    return element.innerHTML;
  }

  function isExtensionContextAvailable() {
    return (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      typeof chrome.runtime.id === "string" &&
      typeof chrome.runtime.sendMessage === "function"
    );
  }

  function classifyWithLayer2(text) {
    return new Promise((resolve) => {
      if (!isExtensionContextAvailable()) {
        console.warn("[Preflight] Layer2 unavailable — extension context invalidated; reload this tab after reloading the extension");
        resolve({ success: false, error: "extension_context_invalidated" });
        return;
      }

      let settled = false;
      const failOpenTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn("[Preflight] Layer2 runtime message timeout — proceeding fail-open");
        resolve({ success: false, error: "runtime_timeout" });
      }, 2500);

      try {
        chrome.runtime.sendMessage(
          { type: "PREFLIGHT_LAYER2_CLASSIFY", text },
          (response) => {
            if (settled) return;
            settled = true;
            clearTimeout(failOpenTimer);
            if (chrome.runtime.lastError) {
              const message = chrome.runtime.lastError.message || "unknown runtime error";
              const contextInvalidated = message.toLowerCase().includes("extension context invalidated");
              console.warn("[Preflight] Layer2 runtime message error —", message);
              resolve({
                success: false,
                error: contextInvalidated ? "extension_context_invalidated" : "runtime_error",
              });
              return;
            }
            debugLog("[Preflight] response returned to content script →", response);
            resolve(response || { success: false, error: "no_response" });
          }
        );
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(failOpenTimer);
        const message = err?.message || "unknown message error";
        const contextInvalidated = message.toLowerCase().includes("extension context invalidated");
        console.warn("[Preflight] Layer2 message send failed —", message);
        resolve({
          success: false,
          error: contextInvalidated ? "extension_context_invalidated" : "message_error",
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Intercept the send action (click on send button, or Enter key)
  //
  // ChatGPT and Claude are React SPAs and can replace the composer nodes
  // between typing and sending. Listen once on `window` instead of
  // attaching to whichever button/input happens to exist at boot time.
  // Window capture is the earliest point in event dispatch, and with
  // run_at: document_start these listeners register before the site's own,
  // so a site handler can't stop the event before we see it.
  // ---------------------------------------------------------------------
  // Prefer the composer that belongs to the same form as the event, so a
  // second matching textarea/contenteditable elsewhere on the page can't be
  // read in its place.
  // Generic editors, used only inside a <form>, so a composer whose ids/names
  // changed in a site redesign is still recognised.
  const GENERIC_EDITOR = 'textarea, [contenteditable="true"]';

  function isVisible(el) {
    return el instanceof Element && el.getClientRects().length > 0;
  }

  // Sites often keep a hidden fallback <textarea> next to the real editor.
  // Pick the visible editor that actually holds text, so we never scan an
  // empty hidden twin and silently let the real prompt through.
  function pickComposer(candidates) {
    const visible = candidates.filter(isVisible);
    return visible.find((el) => getInputText(el).trim().length > 0) || visible[0] || candidates[0] || null;
  }

  function findInputBox(near) {
    const form = near instanceof Element ? near.closest("form") : null;
    if (form) {
      const inForm = pickComposer([
        ...form.querySelectorAll(sel.inputBox),
        ...form.querySelectorAll(GENERIC_EDITOR),
      ]);
      if (inForm) return inForm;
    }
    return pickComposer([...document.querySelectorAll(sel.inputBox)]);
  }

  // Used when the site's own send-button selector stops matching after a
  // redesign: a button labelled "send" that sits near a visible composer.
  const GENERIC_SEND_BUTTON = 'button[aria-label*="send" i], button[data-testid*="send" i]';

  function genericSendFromClick(target) {
    const button = target.closest(GENERIC_SEND_BUTTON);
    if (!button) return null;
    let scope = button.parentElement;
    for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
      const editors = [...scope.querySelectorAll(GENERIC_EDITOR)].filter(isVisible);
      if (editors.length > 0) return { button, inputBox: pickComposer(editors) };
    }
    return null;
  }

  function composerFromEvent(event) {
    const path = event.composedPath().filter((node) => node instanceof Element);
    const known = path.find((node) => node.matches(sel.inputBox));
    if (known) return findInputBox(known);
    const generic = path.find((node) => node.matches(GENERIC_EDITOR) && node.closest("form"));
    return generic ? findInputBox(generic) : null;
  }

  function attachInterceptors() {
    window.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const sendButton = event.target.closest(sel.sendButton);
      if (sendButton) {
        handleSendAttempt(event, findInputBox(sendButton), sendButton);
        return;
      }
      const fallback = genericSendFromClick(event.target);
      if (fallback) handleSendAttempt(event, fallback.inputBox, fallback.button);
    }, true);

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const inputBox = composerFromEvent(event);
      if (!inputBox) {
        const target = event.target instanceof Element ? event.target : null;
        if (target && (target.isContentEditable || target.tagName === "TEXTAREA")) {
          debugLog("[Preflight] Enter in an editor that is not a known composer — ignored", target.tagName, target.id || "", target.getAttribute("name") || "");
        }
        return;
      }

      handleSendAttempt(event, inputBox, document.querySelector(sel.sendButton));
    }, true);

    // Keyboard shortcuts and future site UI changes may submit the composer
    // without producing a click. This is a final interception backstop.
    window.addEventListener("submit", (event) => {
      if (!(event.target instanceof Element)) return;
      const editor = event.target.querySelector(`${sel.inputBox}, ${GENERIC_EDITOR}`);
      const inputBox = editor ? findInputBox(editor) : null;
      if (!inputBox) return;
      handleSendAttempt(event, inputBox, document.querySelector(sel.sendButton));
    }, true);

    debugLog("[Preflight] send interception active (window capture, composer auto-detect)");
  }

  // ---------------------------------------------------------------------
  // Core interception logic
  //
  // IMPORTANT: preventDefault()/stopImmediatePropagation() MUST be called
  // synchronously, before any `await`. Once an async function hits its
  // first await, control returns to the browser and the original click/
  // keydown event continues its normal dispatch — by the time our scan
  // result comes back, the site's own handler has already fired and the
  // message is gone. This was the bug that let messages send before the
  // warning appeared.
  // ---------------------------------------------------------------------
  function handleSendAttempt(event, inputBox, sendButton) {
    // If we already approved this exact send, let it through natively.
    if (pendingSend && pendingSend.approved && pendingSend.text === getInputText(inputBox)) {
      // A button click may synchronously produce a form submit event. Keep
      // the approval alive through the current task so both events pass.
      if (!pendingSend.releaseScheduled) {
        pendingSend.releaseScheduled = true;
        const approvedSend = pendingSend;
        setTimeout(() => {
          if (pendingSend === approvedSend) pendingSend = null;
        }, 0);
      }
      return; // do not preventDefault — allow native send
    }

    // Switched off, paused, or off for this site: let the site send as usual.
    // Files picked meanwhile are dropped so they aren't checked on a later send.
    if (!PreflightProtection.isActive(protection, location.hostname)) {
      pendingAttachments = [];
      return;
    }

    const text = getInputText(inputBox);
    const attachments = pendingAttachments.slice();
    if ((!text || text.trim().length === 0) && attachments.length === 0) {
      debugLog("[Preflight] send ignored — composer text empty", inputBox ? `${inputBox.tagName}#${inputBox.id}` : "no composer found");
      return;
    }

    // Block FIRST, synchronously, no matter what. We decide afterward
    // (once the scan resolves) whether to actually let it through.
    event.preventDefault();
    event.stopImmediatePropagation();

    // Ignore duplicate click/submit events while the same text is already
    // being scanned, but keep every one of them blocked.
    if (pendingSend && pendingSend.scanning && pendingSend.text === text) return;

    pendingSend = { text, findings: [], approved: false, scanning: true };
    debugLog("[Preflight] intercepted send; scanning prompt", attachments.length ? `+ ${attachments.length} attachment(s)` : "");

    runScanAndDecide(text, inputBox, sendButton, attachments);
  }

  // Extracts text from any attached documents and appends it to the typed
  // prompt text so Layer 1 regex + Layer 2 ML both cover attachment content.
  // Returns { scanText, attachmentCount } — never the attachment file names,
  // to keep the same "no raw content in logs" guarantee logEvent already has.
  async function buildScanText(text, attachments) {
    if (!attachments || attachments.length === 0) {
      return { scanText: text, attachmentCount: 0 };
    }
    if (typeof window.PreflightFileScanner === "undefined") {
      console.warn("[Preflight] file scanner unavailable — scanning typed text only");
      return { scanText: text, attachmentCount: attachments.length };
    }
    try {
      const { combinedText } = await window.PreflightFileScanner.extractFilesText(attachments);
      const scanText = combinedText ? `${text}\n\n${combinedText}` : text;
      return { scanText, attachmentCount: attachments.length };
    } catch (error) {
      console.error("[Preflight] attachment text extraction failed", error);
      return { scanText: text, attachmentCount: attachments.length };
    }
  }

  async function runScanAndDecide(text, inputBox, sendButton, attachments) {
    const scanStartedAt = performance.now();
    const { scanText, attachmentCount } = await buildScanText(text, attachments);

    if (!pendingSend || pendingSend.text !== text) return;

    let findings;
    try {
      findings = await window.SentinelDetectors.scan(scanText);
    } catch (error) {
      console.error("[Preflight] prompt scan failed", error);
      pendingSend = null;
      return;
    }

    // The composer may have changed while the asynchronous keyword lookup ran.
    if (!pendingSend || pendingSend.text !== text) return;

    debugLog("[Preflight] Layer1 verdict —", findings.length > 0 ? `${findings.length} finding(s)` : "clean");

    if (findings.length > 0) {
      // Layer 1 flagged something (in the typed text and/or an attachment) —
      // show the existing rich warning immediately.
      pendingSend = { text, findings, approved: false };
      logEvent({ stage: "pre_send", text, findings, action: "layer1_warning_shown", scanStartedAt, attachmentCount });
      showWarningOverlay(findings, {
        onSanitize: async () => {
          // Sanitize only rewrites the typed prompt text — attachment
          // content can't be rewritten in place, so a flagged attachment
          // must be removed by the employee before proceeding.
          const safeText = await window.SentinelDetectors.sanitize(text);
          replaceInputText(inputBox && inputBox.isConnected ? inputBox : findInputBox(sendButton), safeText);
          pendingSend = null;
          logEvent({ stage: "pre_send", text, findings, action: "replaced_with_safe_data", scanStartedAt, attachmentCount });
        },
        onProceed: (action = "proceeded") => {
          pendingSend.approved = true;
          logEvent({ stage: "pre_send", text, findings, action, scanStartedAt, attachmentCount });
          pendingAttachments = [];
          resumeSend(inputBox, sendButton);
        },
        onNotSensitive: (dismissed) => window.SentinelDetectors.ignoreFindings(dismissed),
        onCancel: () => {
          pendingSend = null;
          logEvent({ stage: "pre_send", text, findings, action: "cancelled", scanStartedAt, attachmentCount });
        },
      });
      return;
    }

    // Layer 1 is clean — ask Layer 2 (scanning typed text + attachment text).
    // The background worker only forwards text to the server for connected
    // business accounts; individual users get "layer2_disabled" and nothing
    // ever leaves the browser.
    const layer2Response = await classifyWithLayer2(scanText);

    // Guard: composer may have changed during the Layer 2 round-trip.
    if (!pendingSend || pendingSend.text !== text) return;

    if (!layer2Response || !layer2Response.success) {
      const reason = layer2Response ? layer2Response.error : "unknown";
      // Layer 2 unavailable or not enabled: never block the user — release the send.
      const action = reason === "layer2_disabled" ? "layer1_clean_allowed" : `layer2_${reason}_allowed`;
      logEvent({ stage: "pre_send", text, findings: [], action, scanStartedAt, attachmentCount });
      pendingSend = { text, findings: [], approved: true };
      pendingAttachments = [];
      resumeSend(inputBox, sendButton);
      return;
    }

    const { result } = layer2Response;
    const { risk_level, content_type, confidence } = result;

    logEvent({
      stage: "pre_send",
      text,
      findings: [],
      action: `layer2_verdict_${risk_level}`,
      layer2: { risk_level, content_type, confidence },
      scanStartedAt,
      attachmentCount,
    });

    if (risk_level === "low") {
      // Safe — let it through.
      pendingSend = { text, findings: [], approved: true };
      pendingAttachments = [];
      resumeSend(inputBox, sendButton);
      return;
    }

    // High or medium risk — show Layer 2 warning.
    debugLog("[Preflight] Layer2 warning shown — risk:", risk_level, "type:", content_type);
    pendingSend = { text, findings: [], approved: false };
    showLayer2WarningOverlay(result, {
      onProceed: () => {
        pendingSend.approved = true;
        logEvent({ stage: "pre_send", text, findings: [], action: "layer2_warning_proceeded", layer2: { risk_level, content_type }, scanStartedAt, attachmentCount });
        pendingAttachments = [];
        resumeSend(inputBox, sendButton);
      },
      onCancel: () => {
        pendingSend = null;
        logEvent({ stage: "pre_send", text, findings: [], action: "layer2_warning_cancelled", layer2: { risk_level, content_type }, scanStartedAt, attachmentCount });
      },
    });
  }

  function resumeSend(inputBox, previousSendButton) {
    const liveSendButton = document.querySelector(sel.sendButton) || previousSendButton;
    if (liveSendButton && liveSendButton.isConnected) liveSendButton.click();
    else simulateEnter(document.querySelector(sel.inputBox) || inputBox);
  }

  function simulateEnter(inputBox) {
    inputBox.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  }

  // ---------------------------------------------------------------------
  // Layer 2 warning overlay — shown when ML classifier returns high/medium risk
  // ---------------------------------------------------------------------
  function showLayer2WarningOverlay(result, { onProceed, onCancel }) {
    const existing = document.getElementById("sentinel-overlay");
    if (existing) existing.remove();

    const { risk_level, content_type, confidence, entities = [] } = result;
    const isHigh = risk_level === "high";

    const friendlyType = {
      contract: "Contract / Legal Document",
      financial_report: "Financial Report",
      hr_doc: "HR Document",
      source_code: "Source Code",
      strategy_doc: "Strategy / Internal Document",
      customer_data: "Customer / CRM Data",
      general: "General",
    }[content_type] || content_type;

    const confidencePct = Math.round(confidence * 100);

    const entityList = entities.length > 0
      ? `<ul class="sentinel-l2-entities">${
          entities.slice(0, 6).map(e =>
            `<li><span class="sentinel-l2-entity-label">${escapeHtml(e.label)}</span><span>${escapeHtml(e.text)}</span></li>`
          ).join("")
        }</ul>`
      : "";

    const overlay = document.createElement("div");
    overlay.id = "sentinel-overlay";

    overlay.innerHTML = `
      <section class="sentinel-modal" role="dialog" aria-modal="true" aria-labelledby="sentinel-title" aria-describedby="sentinel-description">
        <header class="sentinel-modal-header sentinel-risk-${isHigh ? "high" : "medium"}">
          <span class="sentinel-header-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M10.3 3.2 2.2 17.3A2 2 0 0 0 3.9 20h16.2a2 2 0 0 0 1.7-2.7L13.7 3.2a2 2 0 0 0-3.4 0Z"/>
              <path d="M12 8v4.5M12 16h.01"/>
            </svg>
          </span>
          <div class="sentinel-header-copy">
            <h2 id="sentinel-title">${isHigh ? "⚠️ Potential Sensitive Information" : "Heads up — Review before sending"}</h2>
            <p>${isHigh ? "This prompt may contain confidential company data." : "This prompt may contain internal information."}</p>
          </div>
          <button id="sentinel-close-btn" class="sentinel-close" type="button" aria-label="Close warning">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <div class="sentinel-content">
          <p id="sentinel-description" class="sentinel-l2-description">
            ${isHigh
              ? "Preflight's ML classifier identified this prompt as likely containing sensitive company data. Sending this to a public AI may expose internal information."
              : "Preflight flagged this prompt as potentially containing internal information. Consider reviewing before sending."}
          </p>
          <div class="sentinel-l2-details">
            <div class="sentinel-l2-row">
              <span class="sentinel-l2-key">Content type</span>
              <strong class="sentinel-l2-value">${escapeHtml(friendlyType)}</strong>
            </div>
            <div class="sentinel-l2-row">
              <span class="sentinel-l2-key">Confidence</span>
              <strong class="sentinel-l2-value">${confidencePct}%</strong>
            </div>
            <div class="sentinel-l2-row">
              <span class="sentinel-l2-key">Risk level</span>
              <strong class="sentinel-l2-value sentinel-l2-risk-${risk_level}">${risk_level.charAt(0).toUpperCase() + risk_level.slice(1)}</strong>
            </div>
          </div>
          ${entityList ? `<div class="sentinel-l2-entity-section"><span class="sentinel-l2-section-label">Detected entities</span>${entityList}</div>` : ""}
          <div class="sentinel-buttons sentinel-l2-buttons">
            <button id="sentinel-proceed-btn" class="sentinel-btn ${isHigh ? "sentinel-btn-proceed" : "sentinel-btn-proceed-medium"}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              <span>Send Anyway</span>
            </button>
            <button id="sentinel-cancel-btn" class="sentinel-btn sentinel-btn-sanitize">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
              <span>Cancel</span>
            </button>
          </div>
        </div>
      </section>
    `;

    document.body.appendChild(overlay);

    const closeOverlay = () => { overlay.remove(); onCancel(); };
    document.getElementById("sentinel-close-btn").addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeOverlay(); });
    overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") closeOverlay(); });
    document.getElementById("sentinel-close-btn").focus();

    document.getElementById("sentinel-proceed-btn").addEventListener("click", () => {
      overlay.remove();
      onProceed();
    });
    document.getElementById("sentinel-cancel-btn").addEventListener("click", closeOverlay);
  }

  // ---------------------------------------------------------------------
  // Layer 1 warning overlay UI (unchanged)
  // ---------------------------------------------------------------------
  function showWarningOverlay(findings, { onSanitize, onProceed, onNotSensitive, onCancel }) {
    const existing = document.getElementById("sentinel-overlay");
    if (existing) existing.remove();

    const RISK_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
    const riskLevel = window.SentinelDetectors.highestRisk(findings);
    const riskLabel = RISK_LABELS[riskLevel] || "Low";
    const personalTypes = new Set(["aadhaar", "pan", "phone", "email", "bank_account"]);
    const credentialTypes = new Set(["openai_key", "anthropic_key", "aws_key", "jwt", "db_url", "private_key", "generic_secret", "hardcoded_password"]);
    const countCategories = (list) => list.reduce((counts, finding) => {
      if (personalTypes.has(finding.type)) counts.personal += 1;
      else if (credentialTypes.has(finding.type)) counts.credentials += 1;
      else counts.business += 1;
      return counts;
    }, { personal: 0, credentials: 0, business: 0 });
    const categoryCounts = countCategories(findings);
    // Private keywords come from the company, so users can't dismiss them.
    const canDismiss = (finding) => finding.type !== "company_keyword";
    const remaining = new Set(findings.keys());

    const overlay = document.createElement("div");
    overlay.id = "sentinel-overlay";
    const icons = {
      alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.3 3.2 2.2 17.3A2 2 0 0 0 3.9 20h16.2a2 2 0 0 0 1.7-2.7L13.7 3.2a2 2 0 0 0-3.4 0Z"/><path d="M12 8v4.5M12 16h.01"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>',
      lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
      building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16M17 9h3v12M8 7h2M8 11h2M8 15h2M13 7h1M13 11h1M13 15h1M2 21h20"/></svg>',
      chevron: '<svg class="sentinel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
      id: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5.5 16c.5-1.5 1.3-2 2.5-2s2 .5 2.5 2M13 10h5M13 14h4"/></svg>',
      shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
      send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    };

    const categoryCard = (kind, label, count, icon) => `
      <div class="sentinel-category ${kind} ${count ? "is-active" : ""}" data-category="${kind}">
        <span class="sentinel-category-icon">${icon}</span>
        <span class="sentinel-category-label">${label}</span>
        <strong>${count}</strong>
      </div>`;

    overlay.innerHTML = `
      <section class="sentinel-modal" role="dialog" aria-modal="true" aria-labelledby="sentinel-title" aria-describedby="sentinel-description">
        <header class="sentinel-modal-header sentinel-risk-${riskLevel}">
          <span class="sentinel-header-icon">${icons.alert}</span>
          <div class="sentinel-header-copy">
            <h2 id="sentinel-title">Sensitive Data Detected</h2>
            <p>Review the details before proceeding.</p>
          </div>
          <button id="sentinel-close-btn" class="sentinel-close" type="button" aria-label="Close warning">${icons.close}</button>
        </header>
        <div class="sentinel-content">
          <div class="sentinel-overview">
            <p id="sentinel-description">This prompt contains data that may expose sensitive personal or business information if sent to a public AI platform.</p>
            <div class="sentinel-risk-card">
              <span>Risk Level</span>
              <strong class="sentinel-risk-badge">${icons.shield}${riskLabel}</strong>
            </div>
          </div>
          <div class="sentinel-summary" aria-label="Detected data categories">
            ${categoryCard("personal", "Personal Information", categoryCounts.personal, icons.person)}
            ${categoryCard("credentials", "Credentials &amp; Secrets", categoryCounts.credentials, icons.lock)}
            ${categoryCard("business", "Business Data", categoryCounts.business, icons.building)}
          </div>
          <button id="sentinel-details-btn" class="sentinel-details-toggle" type="button" aria-expanded="false" aria-controls="sentinel-details">
            ${icons.chevron}<span>View Details</span>
          </button>
          <div id="sentinel-details" class="sentinel-details" hidden>
            ${findings.map((f, index) => `
              <section class="sentinel-detail-item" data-finding="${index}">
                <span class="sentinel-detail-icon">${icons.id}</span>
                <h3>${escapeHtml(f.label)}</h3>
                <div class="sentinel-detail-row"><span class="sentinel-detail-label">Detected:</span><code>${escapeHtml(f.detected || f.match)}</code></div>
                <div class="sentinel-detail-row"><span class="sentinel-detail-label">Replacement:</span><code class="sentinel-safe-value">${escapeHtml(window.SentinelDetectors.replacementFor(f.type))}</code></div>
                ${canDismiss(f) ? `<button class="sentinel-not-sensitive" type="button" data-dismiss="${index}">Not sensitive, don't warn again</button>` : ""}
              </section>`).join("")}
          </div>
          <div class="sentinel-safety-note">${icons.shield}<span>Replacing will keep your prompt useful while protecting sensitive data.</span></div>
          <div class="sentinel-buttons">
            <button id="sentinel-sanitize-btn" class="sentinel-btn sentinel-btn-sanitize">${icons.shield}<span>Replace with Safe Data</span></button>
            <button id="sentinel-proceed-btn" class="sentinel-btn sentinel-btn-proceed">${icons.send}<span>Send Anyway</span></button>
          </div>
          ${findings.some(canDismiss) ? '<button id="sentinel-dismiss-all-btn" class="sentinel-not-sensitive sentinel-dismiss-all" type="button">Not sensitive? Send and don\'t warn me about these again</button>' : ""}
        </div>
      </section>
    `;
    document.body.appendChild(overlay);

    document.getElementById("sentinel-details-btn").addEventListener("click", (event) => {
      const details = document.getElementById("sentinel-details");
      const opening = details.hidden;
      details.hidden = !opening;
      event.currentTarget.querySelector("span").textContent = opening ? "Hide Details" : "View Details";
      event.currentTarget.setAttribute("aria-expanded", String(opening));
    });
    const closeOverlay = () => { overlay.remove(); onCancel(); };
    document.getElementById("sentinel-close-btn").addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOverlay();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeOverlay();
    });
    document.getElementById("sentinel-close-btn").focus();
    document.getElementById("sentinel-sanitize-btn").addEventListener("click", async () => {
      const buttons = overlay.querySelectorAll("button");
      buttons.forEach((button) => { button.disabled = true; });
      try {
        await onSanitize();
        overlay.remove();
      } catch (error) {
        console.error("[Preflight.ai] safe replacement failed", error);
        buttons.forEach((button) => { button.disabled = false; });
      }
    });
    document.getElementById("sentinel-proceed-btn").addEventListener("click", () => {
      overlay.remove();
      onProceed();
    });

    // "Not sensitive": remember the values, drop them from this warning, and
    // send once nothing is left to warn about.
    const dismiss = async (indexes) => {
      try {
        await onNotSensitive(indexes.map((index) => findings[index]));
      } catch (error) {
        console.error("[Preflight.ai] could not save not-sensitive values", error);
        return;
      }
      indexes.forEach((index) => {
        remaining.delete(index);
        overlay.querySelector(`[data-finding="${index}"]`)?.remove();
      });
      const left = [...remaining].map((index) => findings[index]);
      if (left.length === 0) {
        overlay.remove();
        onProceed("marked_not_sensitive");
        return;
      }
      const counts = countCategories(left);
      Object.entries(counts).forEach(([kind, count]) => {
        const card = overlay.querySelector(`[data-category="${kind}"]`);
        card.classList.toggle("is-active", count > 0);
        card.querySelector("strong").textContent = String(count);
      });
      const level = window.SentinelDetectors.highestRisk(left);
      overlay.querySelector(".sentinel-modal-header").className = `sentinel-modal-header sentinel-risk-${level}`;
      overlay.querySelector(".sentinel-risk-badge").lastChild.textContent = RISK_LABELS[level] || "Low";
      if (!left.some(canDismiss)) overlay.querySelector("#sentinel-dismiss-all-btn")?.remove();
    };
    overlay.querySelectorAll("[data-dismiss]").forEach((button) => {
      button.addEventListener("click", () => dismiss([Number(button.dataset.dismiss)]));
    });
    overlay.querySelector("#sentinel-dismiss-all-btn")?.addEventListener("click", () => {
      dismiss([...remaining].filter((index) => canDismiss(findings[index])));
    });
  }

  // ---------------------------------------------------------------------
  // Phase 3 — Post-send confirmation
  // Watches for a new assistant response appearing, confirming the
  // prompt actually left the browser.
  // ---------------------------------------------------------------------
  function observeResponses() {
    const target = document.body;
    let lastResponseCount = document.querySelectorAll(sel.responseContainer).length;
    const observer = new MutationObserver(() => {
      // Only fire when a NEW assistant response container appears. Firing on
      // every DOM mutation (streaming tokens, UI updates) flooded the log.
      const count = document.querySelectorAll(sel.responseContainer).length;
      if (count > lastResponseCount) {
        logEvent({ stage: "post_send_confirmed", text: null, findings: [], action: "response_received" });
      }
      lastResponseCount = count;
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Logging to backend
  // ---------------------------------------------------------------------
  function logEvent(payload) {
    // Never persist or transmit raw prompt content, matched values, or
    // company keyword labels. Type and risk level are enough for analytics.
    const { text, ...safePayload } = payload;
    if (typeof text === "string") {
      safePayload.textLength = text.length;
    }
    if (typeof payload.scanStartedAt === "number") {
      safePayload.latency_ms = Math.max(0, Math.round(performance.now() - payload.scanStartedAt));
      delete safePayload.scanStartedAt;
    }
    if (Array.isArray(safePayload.findings)) {
      safePayload.findings = safePayload.findings.map(({ type, riskLevel }) => ({
        type,
        riskLevel,
      }));
    }
    // Guard: chrome.runtime may be undefined if the extension context was
    // invalidated. A logEvent failure must NEVER throw into the caller —
    // logging is fire-and-forget and must not block the scan pipeline.
    try {
      chrome.runtime.sendMessage({
        type: "SENTINEL_LOG_EVENT",
        payload: {
          ...safePayload,
          site: SITE,
          ai_platform: SITE,
          domain: location.hostname,
          input_source: lastInputSource,
          timestamp: Date.now(),
        },
      });
      lastInputSource = "text_field";
    } catch (err) {
      // Swallow silently — logging failure must never affect send flow.
    }
  }

  // ---------------------------------------------------------------------
  // Self-check. On a page that should have a chat composer, report whether
  // the site's known composer can be found. When it can't, the site's
  // layout has probably changed and sends may slip through unchecked, so
  // the background flags the toolbar icon for this tab. Other pages
  // (settings, login, GPT store) report "unknown" and are never flagged.
  // ---------------------------------------------------------------------
  const CHAT_PATHS = {
    chatgpt: /^\/(?:c\/[^/]+|g\/[^/]+(?:\/c\/[^/]+)?)?\/?$/,
    claude: /^\/(?:new|chat\/[^/]+|project\/[^/]+)\/?$/,
  };
  const HEALTH_INTERVAL_MS = 4000;
  const HEALTH_GRACE_MS = 10000; // the composer renders after the app boots
  let lastHealth = "";
  let composerMissingSince = 0;

  function checkHealth() {
    let status = "unknown";
    if (PreflightProtection.isActive(protection, location.hostname) && CHAT_PATHS[SITE].test(location.pathname)) {
      if ([...document.querySelectorAll(sel.inputBox)].some(isVisible)) {
        composerMissingSince = 0;
        status = "ok";
      } else {
        composerMissingSince = composerMissingSince || Date.now();
        status = Date.now() - composerMissingSince >= HEALTH_GRACE_MS ? "broken" : lastHealth || "unknown";
      }
    } else {
      composerMissingSince = 0;
    }

    if (status === lastHealth) return;
    lastHealth = status;
    try {
      chrome.runtime.sendMessage({ type: "PREFLIGHT_SITE_HEALTH", status }, () => void chrome.runtime.lastError);
    } catch (err) { /* extension context invalidated */ }
  }

  function startHealthChecks() {
    checkHealth();
    setInterval(checkHealth, HEALTH_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  attachInterceptors();
  // Content scripts run at document_start (see manifest), before <body> exists.
  if (document.body) {
    observeResponses();
    startHealthChecks();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observeResponses();
      startHealthChecks();
    }, { once: true });
  }
})();
