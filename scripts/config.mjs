// Builds the PACKAGES config (the Worker secret) from addresses:
//   {origin: {name, lat, lon}, packages: [{id, name, lat, lon}]}
// Only the city name and city-centroid coordinates survive; street, postcode and
// recipient never leave the machine.
//
// An address is {city, state, zip} in the US, or {city, country} elsewhere
// (country as an ISO code or name). Add {lat, lon} (the town centre) for a town
// the place table doesn't have.

import { countryCode, countryName, expandPlaceName, locate, titleCase } from "../src/geo.js";

export function place({ city, state, zip, country, lat, lon }) {
  const cc = countryCode(country);
  const foreign = cc && cc !== "US";
  // Explicit lat/lon (city centre) for towns too small for the place table.
  const hit = lat != null && lon != null ? { name: ",", lat, lon } : locate({ city, state, zip, country });
  if (!hit || (foreign && !hit.name.includes(","))) {
    throw new Error(`can't place ${city}, ${state ?? country} ${zip ?? ""}`.trim());
  }
  // Label with the address's own city (USPS abbreviations expanded), not the
  // geocoder's name, which can be a neighbouring town.
  const region = foreign ? countryName(cc) : state;
  return { name: `${titleCase(expandPlaceName(city))}, ${region}`, lat: hit.lat, lon: hit.lon };
}

export function buildConfig(origin, packages) {
  return {
    origin: place(origin),
    packages: packages.map((p) => ({ id: p.id, ...place(p) })),
  };
}
