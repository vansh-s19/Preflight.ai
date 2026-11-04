# Preflight.ai

Clearance before you send: warns people before personal data, credentials or
confidential information is pasted into public AI tools.

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension (Manifest V3). Personal mode runs fully on-device; business mode connects to the backend. See [extension/README.md](extension/README.md). |
| `scripts/build.mjs` | Builds the Chrome Web Store zip into `dist/`. |
| `store/` | Web Store listing text, permission and privacy answers, screenshots and promo tile, and the pre-submission test checklist. `node scripts/store-assets.mjs` re-renders the images. |
| `backend/` | FastAPI server: `/config`, `/classify` (Layer 2 ML), `/api/scan-event`, `/api/dashboard/*`. |
| `dashboard/` | Admin dashboard source (React + Vite). Project config not yet committed. |
| `website/` | Static marketing site and privacy policy. No build step. |

## Website

```bash
python3 -m http.server 4321 --directory website   # preview at http://localhost:4321
```

Set the Chrome Web Store link and contact email in `website/config.js`. Until
they're filled in, install buttons read "Coming soon" and contact links stay
hidden. Deploy the `website/` folder as-is to GitHub Pages, Vercel or Netlify.
The privacy policy URL for the store listing is `<your-domain>/privacy.html`.

## Extension

```bash
node scripts/build.mjs
node extension/test/detectors.test.js
node extension/test/background.test.js
node extension/test/fileScanner.test.js
```

## Backend

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python models/train_classifier.py   # writes saved_models/text_classifier.joblib
.venv/bin/python -m pytest -q
.venv/bin/uvicorn main:app --port 8000
```
