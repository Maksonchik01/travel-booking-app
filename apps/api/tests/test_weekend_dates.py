"""Швидкі дати (модуль 3 розширення): «лише вихідні» — виліт чт–сб, повернення сб–пн."""

from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest
import respx
from pydantic import ValidationError
from tickets_api.domain.flights import FlightQuery, is_weekend_trip
from tickets_api.domain.trips import TripQuery
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.serpapi import SEARCH_PATH, SerpApiFlightProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.trip_planner import flight_query_for

SERP = "https://serp.test"
NO_RESULTS = {"error": "Google Flights hasn't returned any results for this query."}


def december_weekends(**overrides: Any) -> FlightQuery:
    data: dict[str, Any] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 12, 1),
        "departure_until": date(2026, 12, 31),
        "return_date": date(2026, 12, 2),
        "min_nights": 1,
        "max_nights": 3,
        "weekends": True,
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


def test_weekend_trip_rule() -> None:
    assert is_weekend_trip(date(2026, 12, 4), date(2026, 12, 6))  # пт → нд
    assert is_weekend_trip(date(2026, 12, 3), date(2026, 12, 7))  # чт → пн
    assert not is_weekend_trip(date(2026, 12, 1), date(2026, 12, 6))  # вт
    assert is_weekend_trip(date(2026, 12, 4), date(2026, 12, 5))  # пт → сб
    assert not is_weekend_trip(date(2026, 12, 4), date(2026, 12, 8))  # вт назад
    assert not is_weekend_trip(date(2026, 12, 4), date(2026, 12, 13))  # тиждень+


async def test_search_keeps_only_weekend_pairs() -> None:
    service = FlightSearchService(
        [MockFlightProvider()], timeout_s=5, scoring_config=default_scoring_config()
    )

    result = await service.search(december_weekends())

    assert result.offers
    for offer in result.offers:
        assert offer.inbound is not None
        assert is_weekend_trip(
            offer.outbound.departure_at.date(), offer.inbound.departure_at.date()
        )


@respx.mock
async def test_serpapi_without_candidates_spends_quota_on_weekends_only() -> None:
    route = respx.get(f"{SERP}{SEARCH_PATH}").mock(
        return_value=httpx.Response(200, json=NO_RESULTS)
    )
    async with httpx.AsyncClient() as http:
        provider = SerpApiFlightProvider(
            http,
            "secret-serp-key",
            airports=default_airport_directory(),
            base_url=SERP,
            max_requests_per_search=3,
            clock=lambda: datetime(2026, 11, 10, tzinfo=UTC),
        )
        await provider.search(december_weekends())

    dates = [
        (
            date.fromisoformat(c.request.url.params["outbound_date"]),
            date.fromisoformat(c.request.url.params["return_date"]),
        )
        for c in route.calls
    ]
    assert dates
    assert len(dates) <= 3
    assert all(dep.weekday() in (4, 5) and (back - dep).days == 2 for dep, back in dates)


def test_weekends_need_a_round_trip_period() -> None:
    with pytest.raises(ValidationError):
        december_weekends(departure_until=None, min_nights=None, max_nights=None)
    with pytest.raises(ValidationError):
        december_weekends(return_date=None, min_nights=None, max_nights=None)

    trip = TripQuery(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 12, 1),
        departure_until=date(2026, 12, 31),
        min_nights=1,
        max_nights=3,
        weekends=True,
    )
    assert flight_query_for(trip).weekends is True
    exact = TripQuery(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 12, 4),
        return_date=date(2026, 12, 6),
        weekends=True,
    )
    # Точні дати — «вихідні» вже в самих датах, у пошук перельотів не передаємо.
    assert flight_query_for(exact).weekends is False
