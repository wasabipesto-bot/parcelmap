# /// script
# requires-python = ">=3.11"
# ///
"""Build src/geo-data.json from the GeoNames postal-code dumps (CC BY 4.0).

Output: {"cities": [[name, state, lat, lon], ...], "zips": {"64105": city_index}}
Every coordinate is a city centroid: the mean of that place's ZIP centroids, so
nothing finer than a city ever reaches the site.
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


def rows(country):
    path = CACHE / f"{country}.txt"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        url = f"https://download.geonames.org/export/zip/{country}.zip"
        with urllib.request.urlopen(url) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extract(f"{country}.txt", CACHE)
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
    OUT.write_text(json.dumps({"cities": cities, "zips": zips}, separators=(",", ":")))
    print(f"{len(cities)} places, {len(zips)} ZIPs -> {OUT} ({OUT.stat().st_size // 1024} KiB)", file=sys.stderr)


if __name__ == "__main__":
    main()
