"""Довідник аеропортів, міст і країн: пояси, місто → аеропорти, сусідні аеропорти, пошук.

Знімок даних — airports.json, cities.json, countries.json поруч
(оновлення: scripts/update_reference_data.py).
"""

import json
import math
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from tickets_api.domain.flights import FlightQuery, Offer

DATA_DIR = Path(__file__).parent
MAX_NEARBY_AIRPORTS = 8
"""Разом з обраними. Більше в один запит Google Flights не кладемо — найближчі важливіші."""
MIN_QUERY_LENGTH = 2

Lang = Literal["uk", "en"]


@dataclass(frozen=True, slots=True)
class Airport:
    code: str
    city: str
    tz: str
    name: str
    name_uk: str
    country: str
    lat: float
    lon: float
    routes: int = 0
    """Кількість маршрутів через аеропорт — міра популярності (пасажиропотоку в даних немає)."""


@dataclass(frozen=True, slots=True)
class City:
    code: str
    name: str
    name_uk: str
    country: str
    lat: float
    lon: float


class Place(BaseModel):
    """Варіант автодоповнення: аеропорт або місто, де жоден аеропорт не має коду міста."""

    code: str
    kind: Literal["airport", "city"]
    name: str
    """Аеропорт — його назва; місто — назва міста."""
    city_name: str
    country_name: str
    airports: list[str]


class AirportDirectory:
    def __init__(
        self,
        airports: list[Airport],
        cities: list[City] | None = None,
        countries: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self._by_code = {a.code: a for a in airports}
        self._by_city: dict[str, list[str]] = {}
        for a in airports:
            self._by_city.setdefault(a.city, []).append(a.code)
        self._cities = {c.code: c for c in cities or []}
        self._countries = countries or {}
        # Нормалізовані назви для пошуку: (рядок, код міста чи аеропорту).
        self._city_names = [
            (_normalize(name), c.code)
            for c in self._cities.values()
            for name in (c.name, c.name_uk)
        ]
        self._airport_names = [
            (_normalize(name), a.code) for a in airports for name in (a.name, a.name_uk)
        ]

    @classmethod
    def from_files(cls, directory: Path = DATA_DIR) -> "AirportDirectory":
        def load(name: str) -> Any:
            return json.loads((directory / name).read_text())

        airports = [Airport(**row) for row in load("airports.json")]
        cities = [City(**row) for row in load("cities.json")]
        return cls(airports, cities, load("countries.json"))

    def get(self, code: str) -> Airport | None:
        return self._by_code.get(code.upper())

    def city_of(self, code: str) -> City | None:
        """Місто за кодом міста або аеропорту (WAW → Варшава). Для житла: центр і назва."""
        code = code.upper()
        if (city := self._cities.get(code)) is not None:
            return city
        if (airport := self._by_code.get(code)) is not None:
            return self._cities.get(airport.city) or City(
                airport.city,
                airport.name,
                airport.name_uk,
                airport.country,
                airport.lat,
                airport.lon,
            )
        return None

    def country_codes(self) -> list[str]:
        return sorted(self._countries)

    def knows(self, code: str) -> bool:
        """Код є в довіднику як аеропорт або як місто з аеропортами."""
        code = code.upper()
        return code in self._by_code or code in self._by_city

    def timezone(self, airport_code: str) -> ZoneInfo | None:
        airport = self.get(airport_code)
        return ZoneInfo(airport.tz) if airport else None

    def airports_for(self, code: str, radius_km: int = 0) -> list[str]:
        """Код аеропорту → лише він; код міста без власного аеропорту → усі аеропорти міста.

        WAW — і місто, і аеропорт: користувач обрав саме аеропорт, тож WMI не додаємо.
        LON аеропортом не є → LHR, LGW, STN, ... Невідомий код повертаємо як є.
        `radius_km` > 0 додає найближчі аеропорти в радіусі (разом не більше
        MAX_NEARBY_AIRPORTS): WAW + 150 км → WAW, WMI, LCJ.
        """
        code = code.upper()
        if code in self._by_code:
            own = [code]
        elif code in self._by_city:
            own = sorted(self._by_city[code])
        else:
            return [code]
        center = self._center(code)
        if radius_km <= 0 or center is None or len(own) >= MAX_NEARBY_AIRPORTS:
            return own
        nearby = sorted(
            (distance, a.code)
            for a in self._by_code.values()
            if a.code not in own
            and a.routes > 0  # без регулярних маршрутів шукати нема сенсу
            and (distance := _distance_km(center, (a.lat, a.lon))) <= radius_km
        )
        return own + [c for _, c in nearby[: MAX_NEARBY_AIRPORTS - len(own)]]

    def accepted(self, requested: str, radius_km: int = 0) -> frozenset[str]:
        """Коди, які вважаємо «тим самим місцем», що й `requested`.

        Сам код теж входить: Travelpayouts віддає зворотний рейс з кодом міста.
        """
        requested = requested.upper()
        return frozenset([requested, *self.airports_for(requested, radius_km)])

    def route_filter(self, query: FlightQuery) -> Callable[[Offer], bool]:
        """Перевірка, що пропозиція летить саме з/до обраних аеропортів (WAW ≠ Модлін).

        Набори аеропортів рахуємо один раз на пошук: сусідні — це перебір довідника.
        """
        origin = self.accepted(query.origin, query.origin_radius_km)
        destination = self.accepted(query.destination, query.destination_radius_km)

        def matches(offer: Offer) -> bool:
            out, back = offer.outbound, offer.inbound
            if out.origin not in origin or out.destination not in destination:
                return False
            return back is None or (back.origin in destination and back.destination in origin)

        return matches

    def search(self, text: str, *, limit: int = 8, lang: Lang = "uk") -> list[Place]:
        """Автодоповнення за IATA-кодом, назвою міста чи аеропорту (uk/en, без діакритики).

        Порядок: точний код → назва міста з початку → назва аеропорту з початку →
        слово в назві. Однаковий ранг — популярніші (більше маршрутів) вище.
        """
        needle = _normalize(text)
        if len(needle) < MIN_QUERY_LENGTH:
            return []
        ranked: dict[str, int] = {}  # код міста/аеропорту з префіксом "c:"/"a:" → ранг

        def hit(key: str, rank: int) -> None:
            ranked[key] = min(rank, ranked.get(key, rank))

        code = needle.upper()
        if code in self._cities:
            hit(f"c:{code}", 0)
        if code in self._by_code:
            hit(f"a:{code}", 0)
        for name, city in self._city_names:
            if (rank := _name_rank(name, needle)) is not None:
                hit(f"c:{city}", 1 + rank)
        for name, airport in self._airport_names:
            if (rank := _name_rank(name, needle)) is not None:
                hit(f"a:{airport}", 2 + rank)

        def order(item: tuple[str, int]) -> tuple[int, int, str]:
            key, rank = item
            if key.startswith("c:"):
                popularity = sum(self._by_code[a].routes for a in self._by_city.get(key[2:], []))
            else:
                popularity = self._by_code[key[2:]].routes
            return rank, -popularity, key[2:]

        places: list[Place] = []
        seen: set[str] = set()
        for key, _ in sorted(ranked.items(), key=order):
            if key.startswith("c:"):
                candidates = self._city_places(key[2:], lang)
            else:
                candidates = [self._airport_place(self._by_code[key[2:]], lang)]
            for place in candidates:
                if place.code not in seen:
                    seen.add(place.code)
                    places.append(place)
            if len(places) >= limit:
                break
        return places[:limit]

    def search_cities(self, text: str, *, limit: int = 8, lang: Lang = "uk") -> list[Place]:
        """Лише міста (для житла): «Варшава», а не «Варшава, Шопен» і «Модлін» окремо.

        Той самий пошук і порядок, що й `search`, але кожен збіг — місто, без дублів:
        аеропорт веде до свого міста, назва аеропорту теж знаходить місто.
        """
        places: list[Place] = []
        seen: set[str] = set()
        for place in self.search(text, limit=limit * 4, lang=lang):
            code = place.code if place.kind == "city" else self._by_code[place.code].city
            city = self.city_of(code)
            if city is None or city.code in seen:
                continue
            seen.add(city.code)
            name = city.name_uk if lang == "uk" else city.name
            places.append(
                Place(
                    code=city.code,
                    kind="city",
                    name=name,
                    city_name=name,
                    country_name=self._country_name(city.country, lang),
                    airports=sorted(self._by_city.get(city.code, [])),
                )
            )
            if len(places) >= limit:
                break
        return places

    def coordinates(self, code: str) -> tuple[float, float] | None:
        """Координати аеропорту (чи центру міста) за кодом; None — код невідомий."""
        return self._center(code.upper())

    # --- внутрішнє -----------------------------------------------------------------

    def _center(self, code: str) -> tuple[float, float] | None:
        if (airport := self._by_code.get(code)) is not None:
            return airport.lat, airport.lon
        if (city := self._cities.get(code)) is not None:
            return city.lat, city.lon
        return None

    def _city_places(self, code: str, lang: Lang) -> list[Place]:
        """Місто → «усі аеропорти» (лише якщо код міста не є аеропортом) + кожен аеропорт."""
        airports = sorted(self._by_city.get(code, []))
        places = [self._airport_place(self._by_code[a], lang) for a in airports]
        city = self._cities.get(code)
        if city is None or code in self._by_code or len(airports) < 2:
            return places
        city_name = city.name_uk if lang == "uk" else city.name
        whole = Place(
            code=code,
            kind="city",
            name=city_name,
            city_name=city_name,
            country_name=self._country_name(city.country, lang),
            airports=airports,
        )
        return [whole, *places]

    def _airport_place(self, airport: Airport, lang: Lang) -> Place:
        city = self._cities.get(airport.city)
        name = airport.name_uk if lang == "uk" else airport.name
        city_name = name if city is None else (city.name_uk if lang == "uk" else city.name)
        return Place(
            code=airport.code,
            kind="airport",
            name=name,
            city_name=city_name,
            country_name=self._country_name(airport.country, lang),
            airports=[airport.code],
        )

    def _country_name(self, code: str, lang: Lang) -> str:
        names = self._countries.get(code) or {}
        return names.get("name_uk" if lang == "uk" else "name") or code


def _normalize(text: str) -> str:
    """Регістр, діакритика (Kraków → krakow) і апостроф не заважають пошуку."""
    decomposed = unicodedata.normalize("NFKD", text.casefold().strip())
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return unicodedata.normalize("NFC", stripped).replace("'", "").replace("’", "")


def _name_rank(name: str, needle: str) -> int | None:
    """0 — назва починається з запиту, 1 — якесь слово назви, None — не збігається."""
    if name.startswith(needle):
        return 0
    words = name.replace("-", " ").split()
    if any(word.startswith(needle) for word in words[1:]):
        return 1
    return None


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Відстань між двома точками (широта, довгота) у км — для житла: до центру міста."""
    return _distance_km(a, b)


def _distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Відстань по великому колу (формула гаверсинуса), радіус Землі 6371 км."""
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371 * math.asin(math.sqrt(h))


@lru_cache
def default_airport_directory() -> AirportDirectory:
    return AirportDirectory.from_files()


def default_country_codes() -> list[str]:
    return default_airport_directory().country_codes()
