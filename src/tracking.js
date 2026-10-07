// Turns EasyPost trackers into the public snapshot the page renders.
//
// The snapshot is built field by field from an allowlist, never by copying
// EasyPost objects, so tracking codes, tracker ids, ZIP codes, signer names and
// delivery-spot details ("Front Door/Porch") can't leak through by accident.

import { locate } from "./geo.js";

const STAGES = {
  unknown: ["awaiting", "Awaiting pickup"],
  pre_transit: ["awaiting", "Awaiting pickup"],
  in_transit: ["transit", "In transit"],
  out_for_delivery: ["out", "Out for delivery"],
  available_for_pickup: ["out", "Held at post office"],
  delivered: ["delivered", "Delivered"],
  return_to_sender: ["problem", "Returning to sender"],
  failure: ["problem", "Delivery problem"],
  cancelled: ["problem", "Cancelled"],
  error: ["problem", "Tracking error"],
};

export function stageOf(status) {
  const [stage, text] = STAGES[status] ?? STAGES.unknown;
  return { stage, statusText: text };
}

/** Event text with ZIP codes removed and any delivery detail collapsed to "Delivered". */
export function cleanMessage(message, status) {
  const msg = String(message ?? "").trim();
  if (status === "delivered" || /^delivered\b/i.test(msg)) return "Delivered";
  return msg
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,]+$/, "");
}

const RAD = Math.PI / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Austin, TX", "Austin, TX" -> "Austin, TX (A)", "Austin, TX (B)"; unique labels pass through. */
export function disambiguate(labels) {
  const total = new Map();
  for (const l of labels) total.set(l, (total.get(l) ?? 0) + 1);
  const seen = new Map();
  return labels.map((l) => {
    if (total.get(l) === 1) return l;
    const n = seen.get(l) ?? 0;
    seen.set(l, n + 1);
    return `${l} (${String.fromCharCode(65 + n)})`;
  });
}

const pt = (p) => ({ name: p.name, lat: p.lat, lon: p.lon });

function packageView(pkg, label, origin, tracker) {
  const dest = pt(pkg);
  if (!tracker) {
    return {
      label,
      dest,
      stage: "problem",
      statusText: "Tracking unavailable",
      progress: 0,
      current: pt(origin),
      path: [[origin.lat, origin.lon]],
      events: [],
      estDelivery: null,
      deliveredAt: null,
      lastEventAt: null,
    };
  }
  const { stage, statusText } = stageOf(tracker.status);
  const events = (tracker.tracking_details ?? [])
    .map((d) => {
      const at = Date.parse(d.datetime);
      const where = locate(d.tracking_location ?? {});
      return {
        t: Number.isNaN(at) ? null : new Date(at).toISOString(),
        msg: cleanMessage(d.message, d.status),
        place: where?.name ?? null,
        where,
      };
    })
    .filter((e) => e.t)
    .sort((a, b) => a.t.localeCompare(b.t));

  // Traveled path: origin, then each located scan, collapsing repeats of one city.
  const path = [[origin.lat, origin.lon]];
  let current = pt(origin);
  for (const e of events) {
    if (!e.where) continue;
    current = pt(e.where);
    const [lat, lon] = path[path.length - 1];
    if (lat !== e.where.lat || lon !== e.where.lon) path.push([e.where.lat, e.where.lon]);
  }
  if (stage === "delivered") {
    current = { ...dest };
    const [lat, lon] = path[path.length - 1];
    if (lat !== dest.lat || lon !== dest.lon) path.push([dest.lat, dest.lon]);
  }

  const total = distanceKm(origin, dest);
  const left = distanceKm(current, dest);
  const progress = stage === "delivered" ? 1 : total > 0 ? Math.max(0, Math.min(1, 1 - left / total)) : 0;
  const delivered = stage === "delivered" ? events.findLast((e) => e.msg === "Delivered") : null;

  return {
    label,
    dest,
    stage,
    statusText,
    progress: Math.round(progress * 1000) / 1000,
    current,
    path,
    events: events.map(({ t, msg, place }) => ({ t, msg, place })).reverse(),
    estDelivery: tracker.est_delivery_date ?? null,
    deliveredAt: delivered?.t ?? null,
    lastEventAt: events.at(-1)?.t ?? null,
  };
}

/**
 * config: {origin: {name, lat, lon}, packages: [{id, name, lat, lon}]} (the PACKAGES secret)
 * trackers: EasyPost tracker objects aligned with config.packages (null where a fetch failed)
 */
export function buildSnapshot(config, trackers, now = new Date()) {
  const labels = disambiguate(config.packages.map((p) => p.name));
  return {
    generatedAt: now.toISOString(),
    origin: pt(config.origin),
    packages: config.packages.map((p, i) => packageView(p, labels[i], config.origin, trackers[i])),
  };
}

/** Fetch every tracker; a failed fetch becomes null. Throws only if all of them fail. */
export async function fetchTrackers(config, { apiKey, base = "https://api.easypost.com" }) {
  const auth = `Basic ${btoa(`${apiKey}:`)}`;
  const results = await Promise.allSettled(
    config.packages.map(async (p) => {
      const res = await fetch(`${base}/v2/trackers/${encodeURIComponent(p.id)}`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`EasyPost ${res.status} for package ${p.name}`);
      return res.json();
    }),
  );
  const failures = results.filter((r) => r.status === "rejected");
  for (const f of failures) console.error(f.reason?.message ?? f.reason);
  if (failures.length === results.length && results.length > 0) throw new Error("every tracker fetch failed");
  return results.map((r) => (r.status === "fulfilled" ? r.value : null));
}
