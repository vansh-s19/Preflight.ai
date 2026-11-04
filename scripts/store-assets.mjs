#!/usr/bin/env node
/**
 * Renders the Chrome Web Store screenshots and promo tile into store/assets/
 * with headless Chrome. The warning and popup shown are the real extension
 * UI (store/src/chat.html runs content.js; the popup is extension/src/popup.html
 * with a stubbed chrome API).
 *
 *   node scripts/store-assets.mjs
 *   CHROME=/path/to/chrome node scripts/store-assets.mjs
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "store", "src");
const outDir = join(root, "store", "assets");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "preflight-store-"));

function capture(url, file, width, height) {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${join(work, "profile")}`,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=5000",
    `--screenshot=${file}`,
    url,
  ], { stdio: "ignore" });
}

const fileUrl = (path, query = {}) => {
  const url = pathToFileURL(path);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.href;
};

// The popup with chrome-stub.js loaded first. Scripts point back at the
// real extension files so nothing is duplicated.
function popupPage() {
  const extSrc = join(root, "extension", "src");
  let html = readFileSync(join(extSrc, "popup.html"), "utf8");
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, file) => `<script src="${pathToFileURL(join(extSrc, file)).href}"></script>`);
  html = html.replace("<script ", `<script src="${pathToFileURL(join(srcDir, "chrome-stub.js")).href}"></script>\n  <script `);
  const page = join(work, "popup.html");
  writeFileSync(page, html);
  return page;
}

const SHOTS = [
  {
    name: "1-warning",
    raw: fileUrl(join(srcDir, "chat.html"), { state: "warning" }),
    title: "Stops personal data before it's sent",
    sub: "A warning appears the moment you press send on ChatGPT or Claude.",
  },
  {
    name: "2-details",
    raw: fileUrl(join(srcDir, "chat.html"), { state: "details" }),
    title: "See exactly what it found",
    sub: "PAN, Aadhaar, bank details, phone numbers, API keys, passwords and more.",
  },
  {
    name: "3-replaced",
    raw: fileUrl(join(srcDir, "chat.html"), { state: "replaced" }),
    title: "One click makes it safe to send",
    sub: "Sensitive values become clear placeholders, so the AI can still help.",
  },
  {
    name: "4-popup",
    raw: () => fileUrl(popupPage()),
    rawSize: [390, 580],
    layout: "side",
    title: "You stay in control",
    sub: "Pause it, switch it off on a site, or choose what it checks. Every check runs on your device.",
  },
];

mkdirSync(outDir, { recursive: true });
try {
  for (const shot of SHOTS) {
    const raw = join(work, `${shot.name}-raw.png`);
    const [width, height] = shot.rawSize || [1280, 800];
    capture(typeof shot.raw === "function" ? shot.raw() : shot.raw, raw, width, height);
    const out = join(outDir, `screenshot-${shot.name}.png`);
    capture(fileUrl(join(srcDir, "frame.html"), {
      img: pathToFileURL(raw).href,
      title: shot.title,
      sub: shot.sub,
      layout: shot.layout || "wide",
    }), out, 1280, 800);
    console.log(`store-assets: ${out.slice(root.length + 1)}`);
  }
  const promo = join(outDir, "promo-small-440x280.png");
  capture(fileUrl(join(srcDir, "promo.html")), promo, 440, 280);
  copyFileSync(join(root, "extension", "icons", "icon128.png"), join(outDir, "store-icon-128.png"));
  console.log(`store-assets: ${promo.slice(root.length + 1)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
