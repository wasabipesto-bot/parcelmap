// parcelmap Worker: serves the page with the current snapshot inlined, plus
// /data.json for the page's own refreshes. Static files come from public/.
//
// Snapshots are cached in KV (the Cache API is a no-op on workers.dev) and
// rebuilt from EasyPost at most once per CACHE_TTL_SECONDS. If EasyPost fails,
// the last good snapshot is served with stale: true. The cache key includes a
// fingerprint of PACKAGES, so changing the package list takes effect at once.

import page from "./index.html";
import { buildSnapshot, fetchTrackers } from "./tracking.js";

const RETRY_MS = 60_000;
const KEEP_SECONDS = 30 * 86400; // last-good snapshots outlive a quiet month
let memo = null; // per-isolate {key, snap}, saves a KV read on warm requests
let failedAt = 0;

async function cacheKey(packages) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(packages ?? ""));
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `snapshot:${hex}`;
}

async function snapshot(env, ctx) {
  const ttl = Number(env.CACHE_TTL_SECONDS ?? 300) * 1000;
  const fresh = (s) => s && Date.now() - Date.parse(s.generatedAt) < ttl;
  const key = await cacheKey(env.PACKAGES);
  if (memo?.key === key && fresh(memo.snap)) return memo.snap;
  const cached = await env.CACHE.get(key, "json");
  if (fresh(cached)) {
    memo = { key, snap: cached };
    return cached;
  }
  if (cached && Date.now() - failedAt < RETRY_MS) return { ...cached, stale: true };
  try {
    const config = JSON.parse(env.PACKAGES);
    const trackers = await fetchTrackers(config, { apiKey: env.EASYPOST_API_KEY, base: env.EASYPOST_BASE });
    const snap = buildSnapshot(config, trackers);
    memo = { key, snap };
    ctx.waitUntil(env.CACHE.put(key, JSON.stringify(snap), { expirationTtl: KEEP_SECONDS }));
    return snap;
  } catch (err) {
    console.error("snapshot refresh failed:", err);
    failedAt = Date.now();
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}

const HEADERS = { "cache-control": "no-cache", "x-robots-tag": "noindex, nofollow" };

// JSON inside <script> must not be able to close the tag.
const inline = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/" && pathname !== "/data.json") {
      return new Response("Not found", { status: 404, headers: HEADERS });
    }
    let snap;
    try {
      snap = await snapshot(env, ctx);
    } catch {
      return new Response("Tracking data is unavailable right now.", { status: 503, headers: HEADERS });
    }
    if (pathname === "/data.json") {
      return Response.json(snap, { headers: HEADERS });
    }
    const html = page.replace("<!--SNAPSHOT-->", `<script id="snapshot" type="application/json">${inline(snap)}</script>`);
    return new Response(html, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
  },
};
