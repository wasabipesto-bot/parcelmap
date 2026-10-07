// City-level geocoding over the GeoNames table built by scripts/build_geo.py.
// Every coordinate returned is a city centroid; nothing finer reaches the page.

import geoData from "./geo-data.json" with { type: "json" };

// USPS abbreviates place names on labels and in scans ("FT WORTH", "MT VERNON", "N LAS VEGAS").
const ABBREVIATIONS = {
  CTY: "CITY",
  FT: "FORT",
  ST: "SAINT",
  STE: "SAINTE",
  MT: "MOUNT",
  PT: "POINT",
  HTS: "HEIGHTS",
  SPGS: "SPRINGS",
  SPG: "SPRING",
  JCT: "JUNCTION",
  VLG: "VILLAGE",
  TWP: "TOWNSHIP",
  N: "NORTH",
  S: "SOUTH",
  E: "EAST",
  W: "WEST",
};

let byName;

function index() {
  if (!byName) {
    byName = new Map();
    geoData.cities.forEach((c, i) => byName.set(`${c[0].toUpperCase()}|${c[1]}`, i));
  }
  return byName;
}

const squash = (s) => String(s ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

export function expandPlaceName(name) {
  return squash(name)
    .split(" ")
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(" ");
}

export function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

const place = (i, name) => {
  const [geoName, state, lat, lon] = geoData.cities[i];
  return { name: `${name ?? geoName}, ${state}`, lat, lon };
};

/**
 * Resolve a carrier location ({city, state, zip}) to {name, lat, lon}, or null.
 * Prefers the named city; falls back to the ZIP's city (facility cities such as
 * "NORTH HOUSTON" often aren't places), labelled with the carrier's own name.
 */
export function locate({ city, state, zip } = {}) {
  const st = squash(state);
  if (city && st) {
    for (const name of [squash(city), expandPlaceName(city)]) {
      const i = index().get(`${name}|${st}`);
      if (i !== undefined) return place(i);
    }
  }
  const z = String(zip ?? "").slice(0, 5);
  const i = geoData.zips[z];
  if (i === undefined) return null;
  const hit = place(i);
  if (city && st === geoData.cities[i][1]) hit.name = `${titleCase(expandPlaceName(city))}, ${st}`;
  return hit;
}
