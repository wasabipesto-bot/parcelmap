// Create (or find) the production EasyPost trackers for the real packages and
// write the Worker's secrets (PACKAGES + EASYPOST_API_KEY) to secrets.local.json,
// which `just deploy` uploads with the Worker.
//
//   node scripts/trackers.mjs
//
// Input: packages.local.json (gitignored)
//   {"origin": {"city", "state", "zip"}, "packages": [{"tracking", "city", "state", "zip"}]}
// Tracker ids are written back into that file, so re-runs never create (and pay
// for) a second tracker. A standalone USPS tracker costs ~$0.03.

import { readFileSync, writeFileSync } from "node:fs";
import { buildConfig } from "./config.mjs";

const FILE = "packages.local.json";
const API = "https://api.easypost.com/v2";

function env(name) {
  const line = readFileSync(".env", "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .env`);
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

const key = env("EASYPOST_API_KEY_PROD");
const auth = { Authorization: `Basic ${btoa(`${key}:`)}` };

async function easypost(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...auth, "Content-Type": "application/json", ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(`EasyPost ${res.status}: ${body.error?.code} ${body.error?.message}`);
  return body;
}

async function findOrCreate(tracking) {
  const { trackers } = await easypost(`/trackers?page_size=5&tracking_code=${encodeURIComponent(tracking)}`);
  if (trackers.length) return { tracker: trackers[0], created: false };
  const tracker = await easypost("/trackers", {
    method: "POST",
    body: JSON.stringify({ tracker: { tracking_code: tracking, carrier: "USPS" } }),
  });
  return { tracker, created: true };
}

const data = JSON.parse(readFileSync(FILE, "utf8"));
for (const p of data.packages) {
  if (p.trackerId) continue;
  const { tracker, created } = await findOrCreate(p.tracking);
  p.trackerId = tracker.id;
  writeFileSync(FILE, JSON.stringify(data, null, 1) + "\n"); // save as we go
  console.log(`${created ? "created" : "found  "} tracker for …${p.tracking.slice(-4)}: ${tracker.status}`);
}

const config = buildConfig(
  data.origin,
  data.packages.map((p) => ({ ...p, id: p.trackerId })),
);
console.log(`\norigin: ${config.origin.name}`);
for (const p of config.packages) console.log(`  ${p.name.padEnd(22)} ${p.lat}, ${p.lon}`);

writeFileSync("secrets.local.json", JSON.stringify({ PACKAGES: JSON.stringify(config), EASYPOST_API_KEY: key }) + "\n");
console.log("\nwrote secrets.local.json (gitignored); `just deploy` uploads it");
