// City-level geocoding over the GeoNames table built by scripts/build_geo.py.
// Every coordinate returned is a city (or country) centroid; nothing finer
// reaches the page.

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

// Everything USPS might put in a country field, beyond ISO codes and GeoNames names.
const COUNTRY_ALIASES = {
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  "GREAT BRITAIN": "GB",
  "UNITED KINGDOM": "GB",
  "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "NORTHERN IRELAND": "GB",
};
// Handled by the ZIP-based US table rather than the world table.
const US_AREAS = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);

/** Uppercase, accents folded, punctuation and hyphens as spaces. */
export function squash(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[.,'’()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

let idx;

function index() {
  if (!idx) {
    idx = { us: new Map(), world: new Map(), country: new Map() };
    geoData.cities.forEach((c, i) => idx.us.set(`${squash(c[0])}|${c[1]}`, i));
    // Rows are largest-first, so on a name clash the bigger place wins.
    geoData.world.forEach((c, i) => {
      const key = `${squash(c[0])}|${c[1]}`;
      if (!idx.world.has(key)) idx.world.set(key, i);
    });
    for (const [cc, [name, iso3]] of Object.entries(geoData.countries)) {
      for (const alias of [cc, iso3, name]) idx.country.set(squash(alias), cc);
    }
    for (const [alias, cc] of Object.entries(COUNTRY_ALIASES)) idx.country.set(alias, cc);
  }
  return idx;
}

/** ISO 3166 alpha-2 code for a country field (code, ISO3 or name), or null. */
export function countryCode(country) {
  const key = squash(country);
  return key ? (index().country.get(key) ?? null) : null;
}

export function countryName(cc) {
  return geoData.countries[cc]?.[0] ?? cc;
}

/** Strip facility decoration: "ISC CHICAGO IL (USPS)" -> "CHICAGO". */
function cleanCity(city, state) {
  let c = String(city ?? "").replace(/\(.*?\)/g, " ");
  c = squash(c).replace(/^ISC /, "");
  if (state && c.endsWith(` ${squash(state)}`)) c = c.slice(0, -squash(state).length - 1);
  return c;
}

function usPlace({ city, state, zip }) {
  const st = squash(state);
  const name = cleanCity(city, st);
  if (name && st) {
    for (const n of [name, expandPlaceName(name)]) {
      const i = index().us.get(`${n}|${st}`);
      if (i !== undefined) {
        const [geoName, s, lat, lon] = geoData.cities[i];
        return { name: `${geoName}, ${s}`, lat, lon };
      }
    }
  }
  const i = geoData.zips[String(zip ?? "").slice(0, 5)];
  if (i === undefined) return null;
  const [geoName, s, lat, lon] = geoData.cities[i];
  // Facility cities ("NORTH HOUSTON") often aren't places: keep the carrier's name, use the ZIP's coordinates.
  const label = name && st === s ? titleCase(expandPlaceName(name)) : geoName;
  return { name: `${label}, ${s}`, lat, lon };
}

function worldPlace(city, cc) {
  const name = cleanCity(city);
  if (name) {
    for (const n of [name, expandPlaceName(name)]) {
      const i = index().world.get(`${n}|${cc}`);
      if (i !== undefined) {
        const [geoName, , lat, lon] = geoData.world[i];
        return { name: `${geoName}, ${countryName(cc)}`, lat, lon };
      }
    }
  }
  const c = geoData.countries[cc];
  return c ? { name: c[0], lat: c[2], lon: c[3] } : null;
}

/**
 * Resolve a carrier location ({city, state, zip, country}) to {name, lat, lon}, or null.
 * US: named city, else the ZIP's city. Elsewhere: named city in that country, else the
 * country's centroid (USPS often reports only the country for foreign scans).
 */
export function locate({ city, state, zip, country } = {}) {
  const cc = countryCode(country);
  if (cc && !US_AREAS.has(cc)) return worldPlace(city, cc);
  const hit = usPlace({ city, state, zip });
  if (hit || cc || state) return hit;
  // No country and no state: the "city" may itself be a country ("JAPAN"-style scans).
  const asCountry = countryCode(city);
  return asCountry && !US_AREAS.has(asCountry) ? worldPlace(null, asCountry) : null;
}
