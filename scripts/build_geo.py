# /// script
# requires-python = ">=3.11"
# ///
"""Build src/geo-data.json from GeoNames dumps (CC BY 4.0).

Output:
  cities:    [[name, state, lat, lon], ...]   US places (incl. territories)
  zips:      {"64105": city_index}            US ZIP -> place
  world:     [[name, cc, lat, lon], ...]      non-US places with population >= 5000
  countries: {"JP": [name, iso3, lat, lon]}   population-weighted centroid of each country's places

Every coordinate is a city (or country) centroid; US places are the mean of
their ZIP centroids, so nothing finer than a city ever reaches the site.
"""

import io
import json
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "geonames"
OUT = ROOT / "src" / "geo-data.json"
# US.txt covers the states + DC; territories ship as their own country files.
COUNTRIES = ["US", "PR", "VI", "GU", "AS", "MP"]
# Short names for countries whose GeoNames name is long on a map label.
SHORT_NAMES = {"GB": "UK", "US": "USA"}


def fetch(url, name):
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as r:
            data = r.read()
        if url.endswith(".zip"):
            zipfile.ZipFile(io.BytesIO(data)).extract(name, CACHE)
        else:
            path.write_bytes(data)
    return path


def world():
    """Non-US places with population >= 5000, largest first, plus per-country centroids."""
    path = fetch("https://download.geonames.org/export/dump/cities5000.zip", "cities5000.txt")
    info = fetch("https://download.geonames.org/export/dump/countryInfo.txt", "countryInfo.txt")
    names = {}
    for line in info.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            f = line.split("\t")
            names[f[0]] = (SHORT_NAMES.get(f[0], f[4]), f[1])
    places, weights = [], defaultdict(lambda: [0.0, 0.0, 0.0])
    for line in path.read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        cc, lat, lon, pop = f[8], float(f[4]), float(f[5]), int(f[14] or 0)
        if cc not in names:
            continue
        w = weights[cc]
        w[0] += pop * lat
        w[1] += pop * lon
        w[2] += pop
        if cc not in COUNTRIES:
            places.append((pop, f[1], cc, round(lat, 3), round(lon, 3)))
    places.sort(key=lambda p: -p[0])
    countries = {
        cc: [names[cc][0], names[cc][1], round(w[0] / w[2], 3), round(w[1] / w[2], 3)]
        for cc, w in sorted(weights.items())
        if w[2] > 0
    }
    return [list(p[1:]) for p in places], countries


def rows(country):
    path = fetch(f"https://download.geonames.org/export/zip/{country}.zip", f"{country}.txt")
    for line in path.read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        state = f[4] if country == "US" else country
        if not f[9] or not f[10]:
            continue
        yield f[1], f[2], state, float(f[9]), float(f[10])


def main():
    places = defaultdict(list)  # (NAME, ST) -> [(lat, lon)]
    names = {}
    zip_place = {}
    for country in COUNTRIES:
        for zip5, name, state, lat, lon in rows(country):
            key = (name.upper(), state)
            places[key].append((lat, lon))
            names[key] = name
            zip_place[zip5] = key
    keys = sorted(places)
    index = {k: i for i, k in enumerate(keys)}
    cities = []
    for k in keys:
        pts = places[k]
        lat = sum(p[0] for p in pts) / len(pts)
        lon = sum(p[1] for p in pts) / len(pts)
        cities.append([names[k], k[1], round(lat, 3), round(lon, 3)])
    zips = {z: index[k] for z, k in sorted(zip_place.items())}
    places, countries = world()
    out = {"cities": cities, "zips": zips, "world": places, "countries": countries}
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(
        f"{len(cities)} US places, {len(zips)} ZIPs, {len(places)} world places, {len(countries)} countries"
        f" -> {OUT} ({OUT.stat().st_size // 1024} KiB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
