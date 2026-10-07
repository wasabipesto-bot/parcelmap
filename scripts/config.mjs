// Builds the PACKAGES config (the Worker secret) from addresses:
//   {origin: {name, lat, lon}, packages: [{id, name, lat, lon}]}
// Only the city name and city-centroid coordinates survive; street, ZIP and
// recipient never leave the machine.

import { expandPlaceName, locate, titleCase } from "../src/geo.js";

export function place({ city, state, zip }) {
  const hit = locate({ city, state, zip });
  if (!hit) throw new Error(`can't place ${city}, ${state} ${zip}`);
  // Label with the address's own city (USPS abbreviations expanded), not the
  // ZIP's GeoNames name, which can be a neighbouring town.
  return { name: `${titleCase(expandPlaceName(city))}, ${state}`, lat: hit.lat, lon: hit.lon };
}

export function buildConfig(origin, packages) {
  return {
    origin: place(origin),
    packages: packages.map((p) => ({ id: p.id, ...place(p) })),
  };
}
