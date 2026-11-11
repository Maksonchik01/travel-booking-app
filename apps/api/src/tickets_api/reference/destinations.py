"""Довідник напрямків для Explore (ADR 0045): категорії, сезон моря, регіони, фото.

Знімок `destinations.json` будує `scripts/update_destinations.py`; категорії кураторські.
"""

import json
from dataclasses import dataclass
from datetime import date
from functools import cache
from pathlib import Path

from tickets_api.domain.explore import DestinationPhoto, ExploreCategory, Region

DATA = Path(__file__).parent / "destinations.json"


@dataclass(frozen=True, slots=True)
class DestinationInfo:
    categories: tuple[ExploreCategory, ...]
    sea_months: tuple[int, ...]
    photo: DestinationPhoto | None

    def matches(self, wanted: list[ExploreCategory], departure: date) -> bool:
        """Хоч одна з бажаних категорій; «море» — лише в сезон (місяць вильоту)."""
        for category in wanted:
            if category not in self.categories:
                continue
            if category == "sea" and departure.month not in self.sea_months:
                continue
            return True
        return False


class DestinationDirectory:
    def __init__(self, cities: dict[str, DestinationInfo], regions: dict[str, Region]) -> None:
        self._cities = cities
        self._regions = regions

    @classmethod
    def from_file(cls, path: Path = DATA) -> "DestinationDirectory":
        raw = json.loads(path.read_text())
        cities = {
            code: DestinationInfo(
                categories=tuple(item["categories"]),
                sea_months=tuple(item["sea_months"]),
                photo=DestinationPhoto(**item["photo"]) if item.get("photo") else None,
            )
            for code, item in raw["cities"].items()
        }
        regions = {
            country: region for region, countries in raw["regions"].items() for country in countries
        }
        return cls(cities, regions)

    def info(self, city: str) -> DestinationInfo | None:
        return self._cities.get(city.upper())

    def region_of(self, country: str) -> Region | None:
        return self._regions.get(country.upper())


COVER_CITIES: dict[ExploreCategory, tuple[str, ...]] = {
    "city": ("PRG", "PAR", "LIS"),
    "sea": ("MLA", "TCI", "NCE"),
    "mountains": ("INN", "BGO", "LJU"),
    "romance": ("VCE", "PAR", "SVQ"),
    "culture": ("ROM", "FLR", "ATH"),
    "nightlife": ("BER", "BUD", "IBZ"),
}
"""Обкладинка категорії на головній: перше місто зі списку, що має фото в довіднику."""


def category_covers(
    directory: DestinationDirectory,
) -> list[tuple[ExploreCategory, str, DestinationPhoto]]:
    covers = []
    for category, cities in COVER_CITIES.items():
        for code in cities:
            info = directory.info(code)
            if info is not None and info.photo is not None and category in info.categories:
                covers.append((category, code, info.photo))
                break
    return covers


@cache
def default_destination_directory() -> DestinationDirectory:
    return DestinationDirectory.from_file()
