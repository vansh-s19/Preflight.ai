#!/usr/bin/env node
/**
 * Builds the Chrome Web Store package from extension/.
 *
 *   node scripts/build.mjs                         # personal-only build, no server
 *   PREFLIGHT_API_URL=https://api.example.com \
 *   PREFLIGHT_DASHBOARD_URL=https://app.example.com \
 *     node scripts/build.mjs                       # personal + business build
 *   node scripts/build.mjs --dev                   # business build against http://localhost:8000
 *
 * Output: dist/extension/ (load unpacked) and dist/preflight-ai-<version>[-dev].zip
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "extension");
const distRoot = join(root, "dist");
const outDir = join(distRoot, "extension");
const dev = process.argv.includes("--dev");

const apiUrl = normalizeUrl(process.env.PREFLIGHT_API_URL ?? (dev ? "http://localhost:8000" : ""), "PREFLIGHT_API_URL");
const dashboardUrl = normalizeUrl(process.env.PREFLIGHT_DASHBOARD_URL ?? "", "PREFLIGHT_DASHBOARD_URL");

function normalizeUrl(value, name) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is not a valid URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(dev && local)) {
    fail(`${name} must use https:// (http is only allowed for localhost with --dev)`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

// 1. Fresh copy, without tests or dotfiles.
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(srcDir, outDir, {
  recursive: true,
  filter: (path) => {
    const relative = path.slice(srcDir.length + 1);
    if (!relative) return true;
    return relative !== "test" && !relative.startsWith(`test/`) && !relative.split("/").some((part) => part.startsWith("."));
  },
});

// 2. Inject build-time config.
const configPath = join(outDir, "src", "config.js");
let config = readFileSync(configPath, "utf8");
for (const [marker, value] of [["PREFLIGHT_API_URL", apiUrl], ["PREFLIGHT_DASHBOARD_URL", dashboardUrl]]) {
  const pattern = new RegExp(`"[^"]*",(\\s*// @build:${marker})`);
  if (!pattern.test(config)) fail(`config.js is missing the @build:${marker} marker`);
  config = config.replace(pattern, `${JSON.stringify(value)},$1`);
}
writeFileSync(configPath, config);

// 3. The service worker needs host permission for the API origin only.
const manifestPath = join(outDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (apiUrl) manifest.host_permissions = [`${new URL(apiUrl).origin}/*`];
if (dev) manifest.name = `${manifest.name} (dev)`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Every file the manifest references must exist.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
];
const missing = referenced.filter((file) => !existsSync(join(outDir, file)));
if (missing.length) fail(`manifest references missing files:\n  ${missing.join("\n  ")}`);

// 5. Zip with manifest.json at the archive root.
const zipName = `preflight-ai-${manifest.version}${dev ? "-dev" : ""}.zip`;
execFileSync("zip", ["-qr", join(distRoot, zipName), "."], { cwd: outDir });

console.log(`build: ${dev ? "dev" : "production"} ${manifest.version}`);
console.log(`build: business server ${apiUrl || "(none: personal-only build)"}`);
console.log(`build: unpacked  dist/extension/`);
console.log(`build: package   dist/${zipName}`);
