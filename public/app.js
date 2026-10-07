/* global L */
"use strict";

const STAGES = [
  ["awaiting", "Awaiting pickup"],
  ["transit", "In transit"],
  ["out", "Out for delivery"],
  ["delivered", "Delivered"],
  ["problem", "Problem"],
];
const REFRESH_MS = 5 * 60 * 1000;

let snap = JSON.parse(document.getElementById("snapshot").textContent);
let selected = null; // label of the expanded package
let hovered = null; // label under the pointer, in the list or on the map
let fitted = false;

// ---------- formatting ----------

const exactFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const miles = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Relative time with the exact time on hover. */
function timeEl(iso) {
  return h("time", { datetime: iso, title: exactFmt.format(new Date(iso)), class: "rel" }, ago(iso));
}

/** Estimated delivery is a calendar date; read its date part so time zones can't shift the day. */
function etaDay(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return dayFmt.format(new Date(y, m - 1, d));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (stage) => css(`--stage-${stage}`);

// ---------- geometry ----------

const RAD = Math.PI / 180;

function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Great-circle arc from a to b ([lat, lon]), one vertex per degree. */
function arc(a, b) {
  const v = ([lat, lon]) => [
    Math.cos(lat * RAD) * Math.cos(lon * RAD),
    Math.cos(lat * RAD) * Math.sin(lon * RAD),
    Math.sin(lat * RAD),
  ];
  const p = v(a);
  const q = v(b);
  const w = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  if (w < 1e-6) return [a, b];
  const n = Math.max(2, Math.ceil(w / RAD));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = Math.sin((1 - t) * w) / Math.sin(w);
    const u = Math.sin(t * w) / Math.sin(w);
    const x = s * p[0] + u * q[0];
    const y = s * p[1] + u * q[1];
    const z = s * p[2] + u * q[2];
    out.push([Math.atan2(z, Math.hypot(x, y)) / RAD, Math.atan2(y, x) / RAD]);
  }
  return out;
}

const ll = (p) => [p.lat, p.lon];
const pathArc = (pts) => pts.slice(1).flatMap((q, i) => arc(pts[i], q).slice(i ? 1 : 0));

// ---------- map ----------

const map = L.map("map", { minZoom: 1, maxZoom: 8, zoomSnap: 0.25, worldCopyJump: false });
map.attributionControl.addAttribution("Boundaries: US Census Bureau, Natural Earth");
const dark = matchMedia("(prefers-color-scheme: dark)");

// Base map: drawn from bundled outlines rather than tiles, so there are no API
// keys and the page makes no third-party requests.
map.createPane("base").style.zIndex = 200;
const baseRenderer = L.canvas({ pane: "base", padding: 0.5 });
const baseLayer = L.layerGroup().addTo(map);
let baseData = null;

async function loadBase() {
  const [us, world] = await Promise.all(
    ["/geo/states-10m.json", "/geo/countries-110m.json"].map((u) => fetch(u).then((r) => r.json())),
  );
  // The coarse world layer is context only; the US and Puerto Rico come from the detailed Census outlines.
  const others = {
    type: "GeometryCollection",
    geometries: world.objects.countries.geometries.filter((g) => g.id !== "840" && g.id !== "630"),
  };
  baseData = {
    world: topojson.feature(world, others),
    nation: topojson.feature(us, us.objects.nation),
    states: topojson.mesh(us, us.objects.states, (a, b) => a !== b),
  };
  drawBase();
}

function drawBase() {
  baseLayer.clearLayers();
  if (!baseData) return;
  const opts = { pane: "base", renderer: baseRenderer, interactive: false };
  const land = { fillColor: css("--land"), fillOpacity: 1, color: css("--coast"), weight: 0.75 };
  L.geoJSON(baseData.world, { ...opts, style: land }).addTo(baseLayer);
  L.geoJSON(baseData.nation, { ...opts, style: land }).addTo(baseLayer);
  L.geoJSON(baseData.states, { ...opts, style: { color: css("--border"), weight: 0.75, fill: false } }).addTo(baseLayer);
}

const linesLayer = L.layerGroup().addTo(map);
const placesLayer = L.layerGroup().addTo(map);
const pinsLayer = L.layerGroup().addTo(map);
let marks = new Map(); // label -> {lines: [], dest, pin}
let destLabels = new Map(); // "lat,lon" -> {tip, labels}
let originLabel = null;

function tipHtml(p) {
  const last = p.events[0];
  const where = p.stage === "delivered" ? p.dest.name : last?.place ?? p.current.name;
  const div = h(
    "div",
    {},
    h("div", { class: "t" }, p.label),
    h("div", {}, p.statusText),
    h("div", { class: "s" }, where, last ? ` · ${ago(last.t)}` : ""),
  );
  return div;
}

function drawMap() {
  linesLayer.clearLayers();
  placesLayer.clearLayers();
  pinsLayer.clearLayers();
  marks = new Map();

  // Packages sharing a city fan out around it so each stays visible and hoverable.
  const groups = new Map();
  for (const p of snap.packages) {
    const key = `${p.current.lat},${p.current.lon}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const fanRadius = (n) => (n === 1 ? 0 : Math.min(7 + 3 * n, 30));

  const origin = snap.origin;
  const atOrigin = groups.get(`${origin.lat},${origin.lon}`)?.length ?? 0;
  originLabel = L.circleMarker(ll(origin), { radius: 5, color: css("--ink-2"), weight: 2, fillColor: css("--surface"), fillOpacity: 1 })
    .bindTooltip(origin.name, {
      permanent: true,
      direction: "left",
      offset: [-(fanRadius(atOrigin) + 10), 0],
      className: "place-label origin",
    })
    .addTo(placesLayer);

  // One label per destination city, even when several packages share it.
  destLabels = new Map();
  for (const p of snap.packages) {
    const key = `${p.dest.lat},${p.dest.lon}`;
    if (!destLabels.has(key)) {
      const r = groups.get(key) ? fanRadius(groups.get(key).length) : 0;
      const tip = L.tooltip({ permanent: true, direction: "right", offset: [r + 8, 0], className: "place-label" })
        .setLatLng(ll(p.dest))
        .setContent(p.dest.name);
      placesLayer.addLayer(tip);
      destLabels.set(key, { tip, labels: [] });
    }
    destLabels.get(key).labels.push(p.label);
  }

  for (const p of snap.packages) {
    const c = color(p.stage);
    const lines = [];
    if (p.path.length > 1) {
      lines.push(L.polyline(pathArc(p.path), { color: c, weight: 2, opacity: 0.9, lineCap: "round", lineJoin: "round" }));
    }
    if (p.stage !== "delivered") {
      lines.push(
        L.polyline(arc(ll(p.current), ll(p.dest)), { color: c, weight: 2, opacity: 0.8, dashArray: "2 6", lineCap: "round" }),
      );
    }
    lines.forEach((l) => l.addTo(linesLayer));

    const dest = L.circleMarker(ll(p.dest), { radius: 4, color: c, weight: 2, fillColor: css("--surface"), fillOpacity: 1 })
      .bindTooltip(p.label, { direction: "top", offset: [0, -6], className: "mark-tip" })
      .addTo(placesLayer);

    const group = groups.get(`${p.current.lat},${p.current.lon}`);
    const k = group.indexOf(p);
    const n = group.length;
    const r = fanRadius(n);
    const angle = -Math.PI / 2 + (2 * Math.PI * k) / n;
    const dx = r * Math.cos(angle);
    const dy = r * Math.sin(angle);
    const pin = L.marker(ll(p.current), {
      icon: L.divIcon({
        className: "pin",
        html: `<span style="--c:${c}"></span>`,
        iconSize: [24, 24],
        iconAnchor: [12 - dx, 12 - dy],
      }),
      keyboard: false,
      riseOnHover: true,
    })
      .bindTooltip(() => tipHtml(p), { direction: "top", offset: [dx, dy - 10], className: "mark-tip" })
      .on("mouseover", () => setHover(p.label))
      .on("mouseout", () => setHover(null))
      .on("click", () => select(p.label, true))
      .addTo(pinsLayer);
    pin.getElement()?.setAttribute("data-stage", p.stage);
    marks.set(p.label, { lines, dest, pin });
  }

  if (!fitted) {
    const pts = [ll(snap.origin), ...snap.packages.flatMap((p) => [ll(p.dest), ll(p.current)])];
    // Extra room on the right for the place labels, less of it on a phone.
    const small = map.getSize().x < 600;
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: small ? [16, 24] : [40, 40],
      paddingBottomRight: small ? [48, 24] : [110, 40],
      maxZoom: 7,
    });
    fitted = true;
  }
  applyFocus();
}

function applyFocus() {
  const focus = hovered ?? selected;
  for (const [label, m] of marks) {
    const on = focus === label;
    const off = focus !== null && !on;
    for (const l of m.lines) {
      l.setStyle({ opacity: off ? 0.12 : 0.9, weight: on ? 3 : 2 });
      if (on) l.bringToFront();
    }
    m.dest.setStyle({ opacity: off ? 0.25 : 1 });
    const el = m.pin.getElement();
    el?.classList.toggle("dim", off);
    el?.classList.toggle("focus", on);
    if (on) m.pin.setZIndexOffset(1000);
    else m.pin.setZIndexOffset(0);
  }
  for (const { tip, labels } of destLabels.values()) {
    tip.getElement()?.classList.toggle("dim", focus !== null && !labels.includes(focus));
  }
  declutter();
  document.querySelectorAll(".pkg").forEach((li) => li.classList.toggle("focus", li.dataset.label === focus));
}

/** Hide place labels that would overlap one already shown: origin first, then the focused package's. */
function declutter() {
  const focus = hovered ?? selected;
  const tips = [...destLabels.values()]
    .sort((a, b) => Number(b.labels.includes(focus)) - Number(a.labels.includes(focus)))
    .map((d) => d.tip.getElement());
  const shown = [];
  for (const el of [originLabel?.getTooltip()?.getElement(), ...tips]) {
    if (!el) continue;
    el.classList.remove("crowded");
    const r = el.getBoundingClientRect();
    const hit = shown.some((q) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top);
    if (hit) el.classList.add("crowded");
    else shown.push(r);
  }
}

function setHover(label) {
  hovered = label;
  applyFocus();
}

function select(label, fromMap = false) {
  selected = selected === label ? null : label;
  document.querySelectorAll(".pkg").forEach((li) => {
    const open = li.dataset.label === selected;
    li.querySelector(".pkg-head").setAttribute("aria-expanded", String(open));
    li.querySelector(".timeline").hidden = !open;
    if (open && fromMap) li.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  applyFocus();
}

// ---------- list ----------

function distanceText(p, leftMiles) {
  if (p.stage === "delivered") return "✓";
  if (p.stage === "problem") return "";
  if (leftMiles < 10) return "in town";
  return `${miles.format(leftMiles)} mi to go`;
}

function drawList() {
  const n = snap.packages.length;
  document.getElementById("title").textContent = `${n} package${n === 1 ? "" : "s"} from ${snap.origin.name}`;
  const updated = document.getElementById("updated");
  updated.replaceChildren("Updated ", timeEl(snap.generatedAt), " · refreshes automatically");
  const stale = document.getElementById("stale");
  stale.hidden = !snap.stale;
  stale.textContent = snap.stale ? "Couldn't reach the tracking service just now; showing the last data we have." : "";

  const counts = Object.fromEntries(STAGES.map(([s]) => [s, 0]));
  for (const p of snap.packages) counts[p.stage]++;
  document.getElementById("legend").replaceChildren(
    ...STAGES.filter(([s]) => s !== "problem" || counts.problem > 0).map(([s, text]) =>
      h(
        "li",
        { class: counts[s] ? null : "zero" },
        h("span", { class: "dot", style: `--c:var(--stage-${s})` }),
        text,
        " ",
        h("span", { class: "count" }, String(counts[s])),
      ),
    ),
  );

  const items = [...snap.packages]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((p) => {
      const last = p.events[0];
      const left = distanceKm(p.current, p.dest) / 1.609344;
      const status = h(
        "div",
        { class: "pkg-status" },
        h("span", { class: "status-text" }, p.statusText),
        p.stage === "delivered" && p.deliveredAt
          ? [" ", timeEl(p.deliveredAt)]
          : last
            ? [
                last.msg.toLowerCase() === p.statusText.toLowerCase() ? "" : ` · ${last.msg}`,
                last.place ? ` · ${last.place}` : "",
                " · ",
                timeEl(last.t),
              ]
            : " · no scans yet",
      );
      const eta =
        p.stage !== "delivered" && p.estDelivery
          ? h("div", { class: "pkg-eta", title: `USPS estimate: ${exactFmt.format(new Date(p.estDelivery))}` }, `Expected ${etaDay(p.estDelivery)}`)
          : null;
      const timeline = h(
        "ol",
        { class: "timeline", hidden: selected !== p.label },
        p.events.length
          ? p.events.map((e) =>
              h(
                "li",
                {},
                h("span", { class: "when" }, timeEl(e.t)),
                h("span", { class: "msg" }, e.msg, e.place ? h("span", { class: "where" }, ` · ${e.place}`) : null),
              ),
            )
          : h("li", { class: "when" }, "No scans yet."),
      );
      const li = h(
        "li",
        { class: "pkg", "data-label": p.label, "data-stage": p.stage, style: `--c:var(--stage-${p.stage})` },
        h(
          "button",
          { class: "pkg-head", "aria-expanded": String(selected === p.label) },
          h("span", { class: "dot" }),
          h("span", { class: "pkg-title" }, p.label),
          h("span", { class: "pkg-left" }, distanceText(p, left)),
          h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
        ),
        status,
        eta,
        h("div", { class: "bar", role: "img", "aria-label": `${Math.round(p.progress * 100)}% of the way` }, h("span", { style: `width:${(p.progress * 100).toFixed(1)}%` })),
        timeline,
      );
      li.querySelector(".pkg-head").addEventListener("click", () => select(p.label));
      li.addEventListener("mouseenter", () => setHover(p.label));
      li.addEventListener("mouseleave", () => setHover(null));
      li.addEventListener("focusin", () => setHover(p.label));
      li.addEventListener("focusout", () => setHover(null));
      return li;
    });
  document.getElementById("packages").replaceChildren(...items);
}

// ---------- lifecycle ----------

function render() {
  if (selected && !snap.packages.some((p) => p.label === selected)) selected = null;
  drawList();
  drawMap();
}

async function refresh() {
  try {
    const res = await fetch("/data.json", { cache: "no-store" });
    if (res.ok) {
      snap = await res.json();
      render();
    }
  } catch (err) {
    console.warn("refresh failed", err);
  }
}

render();
loadBase().catch((err) => console.warn("base map failed to load", err));
dark.addEventListener("change", () => {
  drawBase();
  drawMap();
});
map.on("zoomend", declutter);
setInterval(refresh, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - Date.parse(snap.generatedAt) > REFRESH_MS) refresh();
});
setInterval(() => {
  document.querySelectorAll("time.rel").forEach((t) => (t.textContent = ago(t.getAttribute("datetime"))));
}, 30_000);
