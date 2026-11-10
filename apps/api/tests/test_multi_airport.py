"""Кілька аеропортів вильоту й прибуття (модуль 2 розширення): «Амстердам, Роттердам, Ейндговен»."""

from datetime import date
from typing import Any

import httpx
import pytest
import respx
from flight_fakes import StubProvider, offers_for
from pydantic import ValidationError
from tickets_api.domain.flights import FlightQuery, Leg
from tickets_api.domain.trips import TripQuery
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.serpapi import SEARCH_PATH, SerpApiFlightProvider
from tickets_api.providers.travelpayouts import PRICES_FOR_DATES, TravelpayoutsFlightProvider
from tickets_api.reference.airports import MAX_NEARBY_AIRPORTS, default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.trip_planner import flight_query_for

SERP = "https://serp.test"
TP = "https://tp.test"
NO_RESULTS = {"error": "Google Flights hasn't returned any results for this query."}


def query(**overrides: Any) -> FlightQuery:
    data: dict[str, Any] = {
        "origin": "AMS",
        "origin_also": ["RTM", "EIN"],
        "destination": "BCN",
        "departure_date": date(2026, 12, 13),
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


@pytest.fixture
async def http() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


def test_directory_keeps_every_picked_place_first() -> None:
    airports = default_airport_directory()

    assert airports.airports_for_all(["AMS", "RTM", "EIN"]) == ["AMS", "RTM", "EIN"]
    # Місто з багатьма аеропортами не витісняє інші обрані: перший аеропорт кожного — гарантовано.
    both = airports.airports_for_all(["LON", "PAR"])
    assert len(both) <= MAX_NEARBY_AIRPORTS
    assert both[:2] == [airports.airports_for("LON")[0], airports.airports_for("PAR")[0]]
    # Сусідні — після обраних.
    near = airports.airports_for_all(["AMS", "EIN"], radius_km=150)
    assert near[:2] == ["AMS", "EIN"]
    assert len(near) == len(set(near))


def test_route_filter_accepts_any_picked_airport() -> None:
    airports = default_airport_directory()
    accept = airports.route_filter(query(destination_also=["GRO"]))
    offer = offers_for("a", [100])[0]

    def leg(origin: str, destination: str) -> Leg:
        return offer.outbound.model_copy(update={"origin": origin, "destination": destination})

    assert accept(offer.model_copy(update={"outbound": leg("RTM", "GRO")}))
    assert accept(offer.model_copy(update={"outbound": leg("EIN", "BCN")}))
    assert not accept(offer.model_copy(update={"outbound": leg("BRU", "BCN")}))


@respx.mock
async def test_serpapi_one_request_for_all_airports(http: httpx.AsyncClient) -> None:
    route = respx.get(f"{SERP}{SEARCH_PATH}").mock(
        return_value=httpx.Response(200, json=NO_RESULTS)
    )
    provider = SerpApiFlightProvider(
        http, "secret-serp-key", airports=default_airport_directory(), base_url=SERP
    )

    await provider.search(query(destination_also=["GRO"]))

    assert route.call_count == 1  # кілька аеропортів — той самий один запит квоти
    params = route.calls.last.request.url.params
    assert (params["departure_id"], params["arrival_id"]) == ("AMS,RTM,EIN", "BCN,GRO")


@respx.mock
async def test_travelpayouts_asks_each_pair(http: httpx.AsyncClient) -> None:
    route = respx.get(f"{TP}{PRICES_FOR_DATES}").mock(
        return_value=httpx.Response(200, json={"success": True, "data": []})
    )
    provider = TravelpayoutsFlightProvider(http, "secret-token", base_url=TP)

    await provider.search(query(destination_also=["GRO"]))

    pairs = {
        (c.request.url.params["origin"], c.request.url.params["destination"]) for c in route.calls
    }
    assert pairs == {(o, d) for o in ("AMS", "RTM", "EIN") for d in ("BCN", "GRO")}


async def test_history_route_is_the_picked_airport_the_flight_uses() -> None:
    rows: list[dict[str, Any]] = []

    async def record(batch: list[dict[str, Any]]) -> None:
        rows.extend(batch)

    service = FlightSearchService(
        [MockFlightProvider()],
        timeout_s=5,
        scoring_config=default_scoring_config(),
        record_history=record,
    )

    result = await service.search(query())

    origins = {o.outbound.origin for o in result.offers}
    assert origins == {"AMS", "RTM", "EIN"}  # фактичний аеропорт кожного рейсу
    assert {row["origin"] for row in rows} == {"AMS", "RTM", "EIN"}


async def test_extra_airports_are_part_of_the_cache_key() -> None:
    stub = StubProvider("a", offers=offers_for("a", [90]))
    service = FlightSearchService([stub], timeout_s=5, scoring_config=default_scoring_config())

    await service.search(query())

    assert stub.queries[-1].origins == ["AMS", "RTM", "EIN"]
    assert query().model_dump_json() != query(origin_also=[]).model_dump_json()


def test_validation_and_trip_pass_through() -> None:
    with pytest.raises(ValidationError):
        query(origin_also=["BCN"])  # той самий аеропорт з обох боків
    with pytest.raises(ValidationError):
        query(origin_also=["RTM", "RTM"])
    with pytest.raises(ValidationError):
        query(origin_also=["RTM", "EIN", "BRU", "CRL"])  # разом з основним — до 4

    trip = TripQuery(
        origin="AMS",
        origin_also=["RTM"],
        destination="BCN",
        destination_also=["GRO"],
        departure_date=date(2026, 12, 5),
        return_date=date(2026, 12, 8),
    )
    flights = flight_query_for(trip)
    assert (flights.origins, flights.destinations) == (["AMS", "RTM"], ["BCN", "GRO"])
