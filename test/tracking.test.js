import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildConfig } from "../scripts/config.mjs";
import { buildSnapshot, cleanMessage, disambiguate } from "../src/tracking.js";
import { buildTracker } from "./fixtures.js";

const spec = JSON.parse(readFileSync(new URL("./demo-spec.json", import.meta.url)));
const config = buildConfig(spec.origin, spec.packages);
const NOW = Date.parse("2026-10-08T18:00:00Z");
const trackers = spec.packages.map((p) => buildTracker(spec, p, NOW));
const snap = buildSnapshot(config, trackers, new Date(NOW));
const byLabel = Object.fromEntries(snap.packages.map((p) => [p.label, p]));

test("snapshot carries no tracking codes, tracker ids, ZIPs, signers or delivery spots", () => {
  const text = JSON.stringify(snap);
  for (const t of trackers) {
    assert.ok(!text.includes(t.tracking_code), "tracking code leaked");
    assert.ok(!text.includes(t.id), "tracker id leaked");
  }
  assert.doesNotMatch(text, /\b\d{5}\b/, "a ZIP-like number leaked");
  assert.doesNotMatch(text, /porch|front door|J DOE|easypost/i);
});

test("snapshot keys are an allowlist", () => {
  assert.deepEqual(Object.keys(snap).sort(), ["generatedAt", "origin", "packages"]);
  for (const p of snap.packages) {
    assert.deepEqual(Object.keys(p).sort(), [
      "current", "deliveredAt", "dest", "estDelivery", "events", "label", "lastEventAt", "path", "progress", "stage", "statusText",
    ]);
    for (const e of p.events) assert.deepEqual(Object.keys(e).sort(), ["msg", "place", "t"]);
  }
});

test("duplicate destination cities get letters", () => {
  assert.deepEqual(disambiguate(["A", "B", "A", "C", "A"]), ["A (A)", "B", "A (B)", "C", "A (C)"]);
  assert.ok(byLabel["Austin, TX (A)"] && byLabel["Austin, TX (B)"]);
  assert.ok(byLabel["Seattle, WA"]);
});

test("stages map from EasyPost statuses", () => {
  assert.equal(byLabel["Phoenix, AZ"].stage, "awaiting");
  assert.equal(byLabel["Ponce, PR"].stage, "transit");
  assert.equal(byLabel["Seattle, WA"].stage, "transit");
  assert.equal(byLabel["Austin, TX (B)"].stage, "out");
  assert.equal(byLabel["Austin, TX (A)"].stage, "delivered");
  assert.equal(byLabel["Miami, FL"].stage, "problem");
});

test("delivered packages sit at the destination with full progress and a bare 'Delivered'", () => {
  const p = byLabel["Austin, TX (A)"];
  assert.equal(p.progress, 1);
  assert.deepEqual([p.current.lat, p.current.lon], [p.dest.lat, p.dest.lon]);
  assert.equal(p.events[0].msg, "Delivered");
  assert.equal(p.deliveredAt, p.events[0].t);
});

test("position is the last located scan; unlocated scans don't move it", () => {
  const p = byLabel["Honolulu, HI"]; // last scan is "In Transit to Next Facility" (no location)
  assert.equal(p.current.name, "Kansas City, MO");
  assert.equal(p.events[0].place, null);
  assert.equal(byLabel["Seattle, WA"].current.name, "Seattle, WA");
  assert.equal(byLabel["Phoenix, AZ"].progress, 0);
});

test("path starts at the origin and collapses repeated cities", () => {
  const p = byLabel["Seattle, WA"];
  assert.deepEqual(p.path[0], [snap.origin.lat, snap.origin.lon]);
  for (let i = 1; i < p.path.length; i++) assert.notDeepEqual(p.path[i], p.path[i - 1]);
});

test("events are newest first with ISO times", () => {
  for (const p of snap.packages) {
    const ts = p.events.map((e) => e.t);
    assert.deepEqual(ts, [...ts].sort().reverse());
  }
});

test("a failed tracker fetch shows as unavailable instead of breaking the page", () => {
  const s = buildSnapshot(config, trackers.map((t, i) => (i === 0 ? null : t)), new Date(NOW));
  assert.equal(s.packages[0].stage, "problem");
  assert.equal(s.packages[0].statusText, "Tracking unavailable");
});

test("cleanMessage strips ZIPs and delivery detail", () => {
  assert.equal(cleanMessage("Delivered, In/At Mailbox", "delivered"), "Delivered");
  assert.equal(cleanMessage("Delivered to Agent for Final Delivery", "in_transit"), "Delivered");
  assert.equal(cleanMessage("Arrived at Post Office, AUSTIN TX 78701-1234", "in_transit"), "Arrived at Post Office, AUSTIN TX");
  assert.equal(cleanMessage("Delivery Attempted - No Access to Delivery Location", "failure"), "Delivery Attempted - No Access to Delivery Location");
});
