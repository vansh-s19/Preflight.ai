# Preflight.ai — Clearance before you send (Pilot Build, Layer 1 only)

Chrome extension that detects sensitive Indian company data (PII, secrets,
credentials, company keywords) before an employee sends it into ChatGPT or
Claude, and warns them before the message leaves the browser.

This is the **Layer 1 pilot version** — pure pattern matching, no ML, no
backend dependency required to function (logging falls back to local
storage if no backend/auth token is configured).

## What's included

- `manifest.json` — Chrome Manifest V3 config
- `src/detectors.js` — all regex/pattern detection logic (checksum-valid
  Aadhaar, PAN, GSTIN, Indian phone, email, labeled bank accounts, IFSC,
  OpenAI/Anthropic/AWS keys, JWT, database URLs, private keys, hardcoded
  passwords, `.env` values, risky file references, pasted source code, and
  company keywords)
- `src/content.js` — intercepts send actions on chatgpt.com / claude.ai,
  shows the warning overlay, replaces detected data with local synthetic
  placeholders on request, logs privacy-safe decisions, and observes post-send
  responses
- `src/warning.css` — styling for the warning popup
- `src/background.js` — service worker, handles backend communication +
  offline queueing
- `src/popup.html` / `popup.js` — toolbar icon popup showing connection status

## How to load this in Chrome (for testing/pilot)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this folder (`sentinelai-extension`)
5. Open chatgpt.com or claude.ai — the extension is now active
6. Try pasting a fake PAN number (e.g. `ABCDE1234F`) into the prompt box
   and hitting send — the warning overlay should appear. Choose **Replace with
   Safe Data** to change it to `[SYNTHETIC_PAN]` locally before reviewing and
   sending the prompt.

Raw prompts and matched values are never included in extension audit events.
Only metadata such as finding type, risk level, action, and prompt length is
stored or sent to the configured backend.

## What's NOT yet built (by design, this is the pilot scope)

- Layer 2 (ML classifier for unstructured sensitive content)
- Layer 3 (LLM contextual reasoning)
- Real backend — `BACKEND_URL` in `content.js` and `background.js` is a
  placeholder. Until a real backend exists, events are cached locally via
  `chrome.storage.local` and never actually sent anywhere.
- Admin dashboard
- Company onboarding flow (keyword list is currently empty unless manually
  set via `chrome.storage.local.set({ companyKeywords: [...] })` in the
  console for testing)

## Known limitations to be aware of (Layer 1 only)

- Aadhaar detection uses a loose regex + Verhoeff checksum to cut false
  positives, but any 12-digit number that happens to pass the checksum
  will still be flagged — this is expected behavior, not a bug.
- AWS secret key detection (the 40-character secret, as opposed to the
  AKIA... access key) is intentionally left disabled in the merged scan —
  the bare regex is too broad and would cause heavy false positives. Only
  flag this if paired with contextual keywords (`aws_secret`, `secret_key`)
  nearby — left as a TODO for Layer 2.
- Selectors in `content.js` (`SELECTORS.chatgpt` / `SELECTORS.claude`) are
  tied to the current DOM structure of each site as of June 2026. If
  ChatGPT or Claude updates their UI, these selectors will need updating —
  this is the expected maintenance burden discussed for this architecture.
- Layer 1 flags PDF/Excel/`.env`/key filenames pasted into prompt text. It does
  not inspect binary attachment contents; that requires a separate attachment
  interception and document-parsing pipeline.

## Detector regression test

Run `node test/detectors.test.js` after changing Layer 1 rules.

## Next steps (in order)

1. Test locally with the fake data examples above
2. Build a minimal backend (`/v1/events`, `/v1/events/batch`,
   `/v1/companies/me/keywords`) and replace `BACKEND_URL`
3. Build simple company onboarding (collect keyword list, issue auth token)
4. Pilot with 2-3 real users at one company, watch for false
   positives/negatives in real usage
5. Only then consider Layer 2/3
