"""Explore — напрямки за бюджетом (ADR 0045).

Перельоти — на ЗАПИСАНИХ відповідях Travelpayouts «з Амстердама будь-куди, грудень 2026»
(fixtures/travelpayouts/explore_ams_2026-12_*.json, скорочено); житло — mock.
"""

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from flight_fakes import FakeRedis
from httpx import AsyncClient
from pydantic import ValidationError
from tickets_api.domain.explore import ExploreQuery
from tickets_api.domain.flights import Passengers
from tickets_api.providers.cached import CachedFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.providers.travelpayouts import PRICES_FOR_DATES, TravelpayoutsFlightProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.reference.destinations import DATA, default_destination_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.explore import ExploreService
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService

BASE = "https://tp.test"
FIXTURES = Path(__file__).parent / "fixtures" / "travelpayouts"
NOW = datetime(2026, 11, 10, 18, tzinfo=UTC)


def recorded(unique: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(
        (FIXTURES / f"explore_ams_2026-12_unique_{unique}.json").read_text()
    )
    body.pop("_meta", None)
    return body


@pytest.fixture
async def http() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


def mock_tp() -> respx.Route:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=recorded(request.url.params["unique"]))

    return respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(side_effect=respond)


def service(
    http: httpx.AsyncClient, *, stays: bool = False, history: list[Any] | None = None
) -> ExploreService:
    async def record(rows: list[dict[str, Any]]) -> None:
        if history is not None:
            history.extend(rows)

    tp = TravelpayoutsFlightProvider(
        http, "secret-token", airports=default_airport_directory(), base_url=BASE
    )
    flights = FlightSearchService(
        [],
        calendar_providers=[tp],
        timeout_s=5,
        scoring_config=default_scoring_config(),
        record_history=record,
        clock=lambda: NOW,
    )
    stay_search = (
        StaySearchService(
            [MockStayProvider(default_airport_directory(), clock=lambda: NOW)],
            airports=default_airport_directory(),
            timeout_s=5,
            scoring_config=default_stay_scoring_config(),
        )
        if stays
        else None
    )
    return ExploreService(
        flights,
        stay_search,
        airports=default_airport_directory(),
        destinations=default_destination_directory(),
    )


def december(**overrides: Any) -> ExploreQuery:
    data: dict[str, Any] = {
        "origins": ["AMS"],
        "departure_date": date(2026, 12, 1),
        "departure_until": date(2026, 12, 31),
        "min_nights": 2,
        "max_nights": 7,
    }
    data.update(overrides)
    return ExploreQuery.model_validate(data)


@respx.mock
async def test_provider_asks_for_any_destination_both_unique_variants(
    http: httpx.AsyncClient,
) -> None:
    route = mock_tp()
    tp = TravelpayoutsFlightProvider(http, "secret-token", base_url=BASE)

    offers = await tp.explore("AMS", "2026-12", None, "EUR", direct=False)

    params = [call.request.url.params for call in route.calls]
    assert sorted(p["unique"] for p in params) == ["false", "true"]
    for p in params:
        assert "destination" not in p
        assert "return_at" not in p
        assert (p["origin"], p["departure_at"], p["one_way"]) == ("AMS", "2026-12", "false")
    # Об'єднання без дублів; кожна — туди-назад; ціна — як у джерела (за одного дорослого).
    assert len({o.id for o in offers}) == len(offers)
    assert all(o.inbound is not None for o in offers)
    first = recorded("true")["data"][0]
    cheapest = offers[0]
    assert cheapest.price == Decimal(first["price"])
    assert cheapest.inbound is not None
    assert cheapest.inbound.origin == first["destination"]


@respx.mock
async def test_cheapest_fitting_ticket_per_city_within_budget(http: httpx.AsyncClient) -> None:
    mock_tp()
    history: list[Any] = []

    result = await service(http, history=history).explore(december(budget=150, adults=2))

    assert result.providers[0].status == "ok"
    codes = [d.code for d in result.destinations]
    assert len(codes) == len(set(codes))
    assert "AMS" not in codes
    totals = [d.offer.price for d in result.destinations]
    assert totals == sorted(totals)
    # Бюджет — за всіх: ціна джерела × 2 дорослих.
    assert all(p <= 150 for p in totals)
    for d in result.destinations:
        assert 2 <= d.nights <= 7
        assert d.stay_status is None
        assert d.freshness in {"cached", "needs_recheck", "approximate"}
    dublin = next(d for d in result.destinations if d.code == "DUB")
    assert dublin.offer.price == Decimal(72) * 2
    assert dublin.city_name == "Дублін"
    assert dublin.photo is not None
    assert dublin.photo.url.startswith("https://upload.wikimedia.org/")
    # Кожна отримана ціна — в історію, маршрут — за кодами із запиту (місто вильоту).
    assert history
    assert {row["origin"] for row in history} == {"AMS"}
    assert {row["party"] for row in history} == {Passengers().code}  # ціна джерела — за дорослого


@respx.mock
async def test_region_country_and_category_narrow_destinations(http: httpx.AsyncClient) -> None:
    mock_tp()
    explore = service(http)

    everywhere = await explore.explore(december())
    spain = await explore.explore(december(country="ES"))
    africa = await explore.explore(december(region="africa"))
    sea = await explore.explore(december(categories=["sea"]))

    airports = default_airport_directory()
    destinations = default_destination_directory()

    def country(code: str) -> str:
        city = airports.city_of(code)
        assert city is not None
        return city.country

    assert spain.destinations
    assert {country(d.code) for d in spain.destinations} == {"ES"}
    assert africa.destinations
    assert {destinations.region_of(country(d.code)) for d in africa.destinations} == {"africa"}
    assert len(spain.destinations) < len(everywhere.destinations)
    # «Море» в грудні — лише там, де сезон цілий рік (Канари, Червоне море, Агадір).
    assert sea.destinations
    for d in sea.destinations:
        info = destinations.info(d.code)
        assert info is not None
        assert "sea" in info.categories
        assert 12 in info.sea_months
    assert not {"BCN", "LIS", "NCE"} & {d.code for d in sea.destinations}


@respx.mock
async def test_weekends_and_exact_dates(http: httpx.AsyncClient) -> None:
    route = mock_tp()
    explore = service(http)

    weekends = await explore.explore(december(weekends=True, min_nights=1, max_nights=3))
    exact = await explore.explore(
        december(
            departure_until=None,
            min_nights=None,
            max_nights=None,
            departure_date=date(2026, 12, 14),
            return_date=date(2026, 12, 16),
        )
    )

    assert weekends.destinations
    assert exact.destinations
    for d in weekends.destinations:
        assert d.offer.outbound.departure_at.weekday() in (3, 4, 5)
        assert d.offer.inbound is not None
        assert d.offer.inbound.departure_at.weekday() in (5, 6, 0)
    assert route.calls[-1].request.url.params["departure_at"] == "2026-12-14"
    assert route.calls[-1].request.url.params["return_at"] == "2026-12-16"
    for d in exact.destinations:
        assert d.offer.outbound.departure_at.date() == date(2026, 12, 14)


@respx.mock
async def test_trip_mode_prices_stays_only_for_cheapest_three(http: httpx.AsyncClient) -> None:
    mock_tp()

    result = await service(http, stays=True).explore(december(mode="trip", budget=900))

    assert result.stays_checked == 3
    statuses = [d.stay_status for d in result.destinations]
    assert statuses.count("not_checked") == len(statuses) - 3
    priced = [d for d in result.destinations if d.stay_status == "ok"]
    assert priced
    for d in priced:
        assert d.stay is not None
        assert d.total == d.offer.price + d.stay.total_price
        assert d.total <= 900
    # Знайдена загальна сума — нагорі.
    assert result.destinations[: len(priced)] == priced


@respx.mock
async def test_source_failure_is_reported_not_raised(http: httpx.AsyncClient) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=httpx.Response(500))

    result = await service(http).explore(december())

    assert result.destinations == []
    assert result.providers[0].status == "error"


def test_query_validation() -> None:
    with pytest.raises(ValidationError):
        december(country="ES", region="europe")
    with pytest.raises(ValidationError):
        december(departure_until=None, min_nights=None, max_nights=None)  # без повернення
    with pytest.raises(ValidationError):
        december(departure_until=date(2027, 4, 1))  # період довший за 3 місяці
    with pytest.raises(ValidationError):
        december(origins=["AMS", "AMS"])
    assert december(departure_until=date(2027, 2, 10)).months == [
        date(2026, 12, 1),
        date(2027, 1, 1),
        date(2027, 2, 1),
    ]


def test_destination_reference_is_consistent() -> None:
    raw = json.loads(DATA.read_text())
    airports = default_airport_directory()
    categories = {"city", "sea", "mountains", "romance", "culture", "nightlife"}
    for code, item in raw["cities"].items():
        assert airports.city_of(code) is not None, code
        assert set(item["categories"]) <= categories, code
        assert bool(item["sea_months"]) == ("sea" in item["categories"]), code
        assert item["photo"]["url"].startswith("https://upload.wikimedia.org/"), code
        assert item["photo"]["page"].startswith("https://en.wikipedia.org/wiki/"), code
    countries = [c for cs in raw["regions"].values() for c in cs]
    assert len(countries) == len(set(countries))


async def test_explore_api_with_mock_source(client: AsyncClient) -> None:
    response = await client.post(
        "/explore",
        json={
            "origins": ["WAW"],
            "departure_date": "2026-12-01",
            "departure_until": "2026-12-31",
            "min_nights": 2,
            "max_nights": 4,
            "categories": ["city"],
            "lang": "en",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert (data["providers"][0]["provider"], data["providers"][0]["status"]) == ("mock", "ok")
    assert data["destinations"]
    first = data["destinations"][0]
    assert first["photo"]["url"].startswith("https://upload.wikimedia.org/")
    assert "city" in first["categories"]
    assert first["city_name"].isascii()


async def test_category_covers_for_home(client: AsyncClient) -> None:
    response = await client.get("/explore/categories")

    covers = response.json()
    assert [c["category"] for c in covers] == [
        "city",
        "sea",
        "mountains",
        "romance",
        "culture",
        "nightlife",
    ]
    assert all(c["photo"]["url"].startswith("https://upload.wikimedia.org/") for c in covers)


@respx.mock
async def test_repeated_explore_is_served_from_cache(http: httpx.AsyncClient) -> None:
    """Продуктивність (етап 9): той самий пошук напрямків удруге — без запитів до джерела."""
    route = mock_tp()
    tp = CachedFlightProvider(
        TravelpayoutsFlightProvider(http, "secret-token", base_url=BASE),
        FakeRedis(),  # type: ignore[arg-type]
        1800,
    )

    first = await tp.explore("AMS", "2026-12", None, "EUR", direct=False)
    calls = route.call_count
    second = await tp.explore("AMS", "2026-12", None, "EUR", direct=False)

    assert calls == 2  # unique=true і unique=false
    assert route.call_count == calls
    assert first == second
