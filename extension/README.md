# Preflight.ai Chrome extension

Warns you before personal data, credentials or confidential information is
sent to ChatGPT or Claude. Supported sites: chatgpt.com, chat.openai.com, claude.ai.

## Modes

| | Free (personal) | Enterprise (business) |
|---|---|---|
| Account | None | Company access token, entered in the popup |
| Pattern checks (Layer 1: PAN, Aadhaar, GSTIN, keys, passwords, files…) | On-device | On-device |
| On/off, pause 1 hour, off per site | Popup | Popup |
| Popup | Weekly counter | Full history, charts, CSV/JSON export |
| Private keywords | — | Set in the popup |
| AI checks (Layer 2) | Off | On if the org's plan includes it (prompt text goes to the company's Preflight server) |
| Telemetry | None. History stays in `chrome.storage.local` | Metadata only (finding types, severity, action, timing). Never prompt text or page titles |

A build made without `PREFLIGHT_API_URL` is personal-only and makes no network
requests at all.

## Build

```bash
node scripts/build.mjs                    # personal-only store package
PREFLIGHT_API_URL=https://api.example.com PREFLIGHT_DASHBOARD_URL=https://app.example.com node scripts/build.mjs
node scripts/build.mjs --dev              # business mode against http://localhost:8000
```

Output: `dist/extension/` (load unpacked from `chrome://extensions`) and
`dist/preflight-ai-<version>.zip` (upload to the Chrome Web Store).

## Tests

```bash
node extension/test/detectors.test.js
node extension/test/background.test.js
```

## Third-party code

`src/vendor/` bundles pdf.js 3.11.174 (Apache-2.0) and mammoth 1.8.0
(BSD-2-Clause) for reading PDF/DOCX attachments locally. Licenses sit alongside.
