# Preflight.ai

Clearance before you send: warns people before personal data, credentials or
confidential information is pasted into public AI tools.

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension (Manifest V3). Personal mode runs fully on-device; business mode connects to the backend. See [extension/README.md](extension/README.md). |
| `scripts/build.mjs` | Builds the Chrome Web Store zip into `dist/`. |
| `backend/` | FastAPI server: `/config`, `/classify` (Layer 2 ML), `/api/scan-event`, `/api/dashboard/*`. |
| `dashboard/` | Admin dashboard source (React + Vite). Project config not yet committed. |

## Extension

```bash
node scripts/build.mjs
node extension/test/detectors.test.js
node extension/test/background.test.js
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
