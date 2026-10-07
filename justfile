# parcelmap: live map of USPS packages, served by a Cloudflare Worker.
set shell := ["bash", "-cu"]
set dotenv-load

default:
    @just --list

# Install npm dependencies and build the geocoding table.
setup:
    npm ci
    just geo

# Build src/geo-data.json from the GeoNames postal-code dumps.
geo:
    uv run scripts/build_geo.py

# Unit tests (redaction, stages, labels, paths).
test:
    npm test

# Local preview against a mock EasyPost (default: the fictional demo spec).
dev spec="test/demo-spec.json":
    node scripts/dev.mjs {{spec}} -- --port 8787 --ip 127.0.0.1

# Create/find the real EasyPost trackers and write secrets.local.json.
trackers:
    node scripts/trackers.mjs

# Create the KV namespace used as the snapshot cache (once); paste its id into wrangler.jsonc.
kv:
    npx wrangler kv namespace create parcelmap-cache

# Deploy the Worker together with the secrets from secrets.local.json.
deploy: test
    test -f src/geo-data.json || just geo
    npx wrangler deploy --secrets-file secrets.local.json

# Copy vendored front-end libraries and outline data out of node_modules.
vendor:
    cp node_modules/leaflet/dist/leaflet.{js,css} public/vendor/leaflet/
    cp node_modules/topojson-client/dist/topojson-client.min.js public/vendor/topojson-client/
    cp node_modules/us-atlas/states-10m.json node_modules/world-atlas/countries-110m.json public/geo/
