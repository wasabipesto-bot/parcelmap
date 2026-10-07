# parcelmap

A live map of a handful of USPS packages, served by a single Cloudflare Worker.

Each package shows where its latest scan happened, the path it has traveled, and a dashed
straight line for the rest of the trip. USPS tracking is a series of facility scans, not GPS,
so markers jump from city to city instead of moving smoothly.

## How it works

- **Tracking data:** [EasyPost](https://www.easypost.com/) standalone trackers. Since
  April 2026 the USPS API only serves packages under your own Mailer ID, so retail labels
  such as Click-N-Ship go through a third party (about $0.03 per tracker).
- **The Worker** (`src/worker.js`) serves the page with the current snapshot inlined, plus
  `/data.json` for the page's own refresh every 5 minutes.
  - On a cache miss it fetches every tracker from EasyPost and builds the snapshot.
  - It caches the snapshot in Workers KV for `CACHE_TTL_SECONDS`. The Cache API does
    nothing on `workers.dev`, hence KV.
  - If EasyPost fails, it serves the last good snapshot marked stale.
- **Privacy:** the page only ever shows city names.
  - `src/tracking.js` builds the snapshot field by field from an allowlist, so the page
    never sees tracking numbers, tracker ids, ZIP codes, signer names or where a package
    was left.
  - Every coordinate is a city centroid from the bundled GeoNames table.
  - The package list lives only in the `PACKAGES` Worker secret, never in this repo.
- **Map:** Leaflet over outlines drawn from bundled US Census (`us-atlas`) and Natural Earth
  (`world-atlas`) data. There are no tile servers or API keys, and no third-party requests.

## Setup

Needs Node, [uv](https://docs.astral.sh/uv/) and [just](https://just.systems/).

```sh
just setup     # npm ci + build src/geo-data.json from GeoNames
just test
just dev       # local preview at :8787 against a mock EasyPost with fictional demo packages
```

`.env` (gitignored):

```sh
EASYPOST_API_KEY_PROD=...
EASYPOST_API_KEY_TEST=...
CLOUDFLARE_API_TOKEN=...      # "Edit Cloudflare Workers" template
CLOUDFLARE_ACCOUNT_ID=...
```

`packages.local.json` (gitignored). The sender's ZIP is used only to place the origin:

```json
{
  "origin": { "city": "KANSAS CITY", "state": "MO", "zip": "64105" },
  "packages": [{ "tracking": "9400...", "city": "AUSTIN", "state": "TX", "zip": "78701" }]
}
```

Then:

```sh
just trackers  # create/find the EasyPost trackers (ids are saved back, so re-runs don't re-pay)
               # and write secrets.local.json
just kv        # once: create the KV namespace, put its id in wrangler.jsonc
just deploy    # tests, then wrangler deploy with the secrets
```

Two packages to the same city are labeled "City, ST (A)", "City, ST (B)".

## Data credits

- Place coordinates: [GeoNames](https://www.geonames.org/) postal codes, CC BY 4.0.
- Outlines: US Census Bureau cartographic boundaries via
  [us-atlas](https://github.com/topojson/us-atlas), and [Natural Earth](https://www.naturalearthdata.com/)
  via [world-atlas](https://github.com/topojson/world-atlas).
