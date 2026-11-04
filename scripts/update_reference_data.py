"""Оновлює знімок довідника аеропортів, міст і країн з публічних даних Travelpayouts.

    uv run python scripts/update_reference_data.py

Джерела (без токена): https://api.travelpayouts.com/data/{en,uk}/airports.json,
/data/uk/cities.json, /data/uk/countries.json, /data/uk/airlines.json, /data/routes.json. Поля звірено з реальними
відповідями (листопад 2026): `code`, `city_code`, `country_code`, `time_zone`, `iata_type`,
`flightable`, `name`, `name_translations.en`, `coordinates.{lat,lon}`;
у routes — `departure_airport_iata`, `arrival_airport_iata`.
Лишаємо лише аеропорти з регулярними рейсами, їхні міста і країни. `routes` — кількість
маршрутів через аеропорт: міра популярності для автодоповнення і сусідніх аеропортів.
"""

import json
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

BASE = "https://api.travelpayouts.com/data"
TARGET_DIR = Path(__file__).parents[1] / "apps/api/src/tickets_api/reference"


def fetch(path: str) -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = httpx.get(f"{BASE}/{path}", timeout=60).raise_for_status().json()
    return data


def english(row: dict[str, Any]) -> str:
    return str((row.get("name_translations") or {}).get("en") or row.get("name") or row["code"])


def coords(row: dict[str, Any]) -> tuple[float, float] | None:
    c = row.get("coordinates") or {}
    if c.get("lat") is None or c.get("lon") is None:
        return None
    return round(float(c["lat"]), 5), round(float(c["lon"]), 5)


def write(name: str, data: object) -> None:
    (TARGET_DIR / name).write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    )


def main() -> None:
    uk_airports = {a["code"]: a for a in fetch("uk/airports.json")}
    routes: Counter[str] = Counter()
    for r in fetch("routes.json"):
        routes[str(r.get("departure_airport_iata"))] += 1
        routes[str(r.get("arrival_airport_iata"))] += 1
    airports = []
    for a in fetch("en/airports.json"):
        point = coords(a)
        if not (a.get("iata_type") == "airport" and a.get("flightable") and a.get("time_zone")):
            continue
        if point is None:
            continue
        uk_name = (uk_airports.get(a["code"]) or {}).get("name")
        airports.append(
            {
                "code": a["code"],
                "city": a["city_code"],
                "tz": a["time_zone"],
                "name": english(a),
                "name_uk": uk_name or english(a),
                "country": a["country_code"],
                "lat": point[0],
                "lon": point[1],
                "routes": routes[a["code"]],
            }
        )
    airports.sort(key=lambda a: a["code"])

    city_codes = {a["city"] for a in airports}
    cities = []
    for c in fetch("uk/cities.json"):
        point = coords(c)
        if c["code"] not in city_codes or point is None:
            continue
        cities.append(
            {
                "code": c["code"],
                "name": english(c),
                "name_uk": c.get("name") or english(c),
                "country": c["country_code"],
                "lat": point[0],
                "lon": point[1],
            }
        )
    cities.sort(key=lambda c: c["code"])

    country_codes = {a["country"] for a in airports}
    countries = {
        c["code"]: {"name": english(c), "name_uk": c.get("name") or english(c)}
        for c in sorted(fetch("uk/countries.json"), key=lambda c: c["code"])
        if c["code"] in country_codes
    }

    write("airports.json", airports)
    write("cities.json", cities)
    write("countries.json", countries)
    # Українських назв авіакомпаній у даних немає (name=None) — бренди латиницею, як у квитках.
    airlines = {
        a["code"]: english(a)
        for a in sorted(fetch("uk/airlines.json"), key=lambda a: str(a.get("code")))
        if a.get("code")
    }
    write("airlines.json", airlines)
    print(
        f"{len(airports)} аеропортів, {len(cities)} міст, {len(countries)} країн, "
        f"{len(airlines)} авіакомпаній → {TARGET_DIR}"
    )


if __name__ == "__main__":
    main()
