"""Адаптер SerpApi Google Flights на ЗАПИСАНИХ реальних відповідях (tests/fixtures/serpapi/)."""

import copy
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.base import ProviderError, ProviderRateLimitedError
from tickets_api.providers.serpapi import SEARCH_PATH, SerpApiFlightProvider
from tickets_api.reference.airports import default_airport_directory

BASE = "https://serp.test"
URL = f"{BASE}{SEARCH_PATH}"
KEY = "secret-serp-key"
NOW = datetime(2026, 11, 2, 12, 0, 30, 5, tzinfo=UTC)
FIXTURES = Path(__file__).parent / "fixtures" / "serpapi"
NO_RESULTS = {"error": "Google Flights hasn't returned any results for this query."}


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    body.pop("_meta", None)
    return body


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


def make_provider(client: httpx.AsyncClient, **kwargs: Any) -> SerpApiFlightProvider:
    return SerpApiFlightProvider(
        client,
        KEY,
        airports=default_airport_directory(),
        base_url=BASE,
        clock=lambda: NOW,
        **kwargs,
    )


@pytest.fixture
def provider(client: httpx.AsyncClient) -> SerpApiFlightProvider:
    return make_provider(client)


def one_way(**overrides: Any) -> FlightQuery:
    data: dict[str, Any] = {
        "origin": "WAW",
        "destination": "BCN",
        "departure_date": date(2026, 12, 13),
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


@respx.mock
async def test_maps_recorded_one_way(provider: SerpApiFlightProvider) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("oneway")))

    offers = await provider.search(one_way())

    params = dict(route.calls.last.request.url.params)
    assert params == {
        "engine": "google_flights",
        "departure_id": "WAW",  # лише обраний аеропорт, без Модліна (WMI)
        "arrival_id": "BCN",
        "currency": "EUR",
        "hl": "en",
        "adults": "1",
        "type": "2",
        "outbound_date": "2026-12-13",
        "api_key": KEY,
    }
    assert [o.price for o in offers] == [Decimal(48), Decimal(64), Decimal(84), Decimal(99)]
    cheapest = offers[0]
    assert cheapest.source == "serpapi"
    assert cheapest.details_level == "full"
    assert cheapest.found_at == cheapest.collected_at == NOW.replace(microsecond=0)
    assert cheapest.baggage_included is None
    assert cheapest.airlines == ["W6"]
    assert cheapest.deep_link is not None
    assert cheapest.deep_link.startswith("https://www.google.com/travel/flights?")
    leg = cheapest.outbound
    assert (leg.origin, leg.destination, leg.stops, leg.duration_min) == ("WAW", "BCN", 0, 190)
    # Місцевий час із поясом аеропорту: Варшава і Барселона взимку обидві UTC+1.
    assert leg.departure_at.isoformat() == "2026-12-13T06:20:00+01:00"
    assert leg.arrival_at is not None
    assert leg.arrival_at.isoformat() == "2026-12-13T09:30:00+01:00"
    assert leg.flight_number == "W61475"
    assert leg.layovers == []


@respx.mock
async def test_city_without_own_airport_expands(provider: SerpApiFlightProvider) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=NO_RESULTS))

    await provider.search(one_way(origin="LON"))

    assert route.calls.last.request.url.params["departure_id"] == "LCY,LGW,LHR,LTN,SEN,STN"


@respx.mock
async def test_layovers_come_with_airport_and_duration(provider: SerpApiFlightProvider) -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("oneway")))

    offers = await provider.search(one_way())

    klm = next(o for o in offers if o.price == Decimal(84))
    leg = klm.outbound
    assert leg.stops == 1
    assert [s.flight_number for s in leg.segments or []] == ["KL1310", "KL1513"]
    assert leg.layovers is not None
    [layover] = leg.layovers
    assert (layover.airport, layover.duration_min, layover.overnight) == ("AMS", 110, False)
    assert layover.self_transfer is None  # Google не повідомляє — «невідомо», не «ні»
    assert leg.duration_min == 370


@respx.mock
async def test_round_trip_fetches_returns_for_cheapest_outbounds(client: httpx.AsyncClient) -> None:
    rt = recorded("rt")
    tokens = [it["departure_token"] for it in rt["best_flights"] + rt["other_flights"]]

    def respond(request: httpx.Request) -> httpx.Response:
        token = request.url.params.get("departure_token")
        if token is None:
            return httpx.Response(200, json=rt)
        if token == tokens[0]:
            return httpx.Response(200, json=recorded("return"))
        return httpx.Response(200, json=NO_RESULTS)

    route = respx.get(URL).mock(side_effect=respond)
    provider = make_provider(client, returns_per_date=2)

    offers = await provider.search(
        FlightQuery(
            origin="WAW",
            destination="LIS",
            departure_date=date(2026, 12, 5),
            return_date=date(2026, 12, 12),
        )
    )

    assert route.call_count == 3  # вильоти + зворотні для 2 найдешевших
    assert route.calls[0].request.url.params["type"] == "1"
    [offer] = offers
    assert offer.price == Decimal(152)  # ціна з відповіді із зворотними — за всю поїздку
    assert offer.outbound.flight_number == "W61593"
    assert offer.inbound is not None
    assert offer.inbound.flight_number == "W61594"
    assert offer.inbound.departure_at.isoformat() == "2026-12-12T17:30:00+00:00"
    assert offer.total_duration_min == 265 + 240


@respx.mock
async def test_request_budget_is_respected(client: httpx.AsyncClient) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=NO_RESULTS))
    provider = make_provider(client, max_requests_per_search=3)

    await provider.search(one_way(flex_days=3))

    dates = [c.request.url.params["outbound_date"] for c in route.calls]
    assert dates == ["2026-12-13", "2026-12-12", "2026-12-14"]  # найближчі до запитаної


@respx.mock
async def test_past_dates_are_not_queried(client: httpx.AsyncClient) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=NO_RESULTS))
    provider = make_provider(client, max_requests_per_search=10)

    await provider.search(one_way(departure_date=date(2026, 11, 3), flex_days=2))

    dates = sorted(c.request.url.params["outbound_date"] for c in route.calls)
    assert dates == ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]


@respx.mock
async def test_direct_only(provider: SerpApiFlightProvider) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("oneway")))

    offers = await provider.search(one_way(direct_only=True))

    assert route.calls.last.request.url.params["stops"] == "1"
    assert offers
    assert all(o.stops == 0 for o in offers)


@respx.mock
async def test_overnight_layover_is_computed_from_local_times(
    provider: SerpApiFlightProvider,
) -> None:
    body = recorded("oneway")
    it = copy.deepcopy(next(i for i in body["other_flights"] if i.get("layovers")))
    first, second = it["flights"]
    first["arrival_airport"]["time"] = "2026-12-13 23:30"
    second["departure_airport"]["time"] = "2026-12-14 05:10"
    second["arrival_airport"]["time"] = "2026-12-14 07:20"
    it["layovers"][0].pop("overnight", None)
    respx.get(URL).mock(return_value=httpx.Response(200, json={"best_flights": [it]}))

    [offer] = await provider.search(one_way())

    assert offer.outbound.layovers is not None
    assert offer.outbound.layovers[0].overnight is True


@respx.mock
async def test_unknown_airport_timezone_skips_itinerary(provider: SerpApiFlightProvider) -> None:
    body = recorded("oneway")
    body["best_flights"][0]["flights"][0]["departure_airport"]["id"] = "ZZZ"
    respx.get(URL).mock(return_value=httpx.Response(200, json=body))

    offers = await provider.search(one_way())

    assert Decimal(48) not in [o.price for o in offers]
    assert len(offers) == 3


@respx.mock
async def test_only_google_flights_links_are_used(provider: SerpApiFlightProvider) -> None:
    body = recorded("oneway")
    body["search_metadata"]["google_flights_url"] = "https://evil.example/phish"
    respx.get(URL).mock(return_value=httpx.Response(200, json=body))

    offers = await provider.search(one_way())

    assert all(o.deep_link is None for o in offers)


@respx.mock
async def test_no_results_is_not_an_error(provider: SerpApiFlightProvider) -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, json=NO_RESULTS))

    assert await provider.search(one_way()) == []


@pytest.mark.parametrize(
    ("response", "error", "message"),
    [
        (httpx.Response(401, json={"error": "Invalid API key."}), ProviderError, "auth failed"),
        (
            httpx.Response(429, json={"error": "Your account has run out of searches."}),
            ProviderRateLimitedError,
            "quota",
        ),
        (httpx.Response(500, json={"error": "boom"}), ProviderError, "HTTP 500"),
        (httpx.Response(502, text="<html>"), ProviderError, "invalid JSON"),
    ],
)
@respx.mock
async def test_failures_become_provider_errors(
    provider: SerpApiFlightProvider,
    response: httpx.Response,
    error: type[ProviderError],
    message: str,
) -> None:
    respx.get(URL).mock(return_value=response)

    with pytest.raises(error, match=message) as exc_info:
        await provider.search(one_way())
    assert KEY not in str(exc_info.value)


@respx.mock
async def test_network_error_does_not_leak_key(provider: SerpApiFlightProvider) -> None:
    respx.get(URL).mock(side_effect=httpx.ConnectError(f"failed {URL}?api_key={KEY}"))

    with pytest.raises(ProviderError) as exc_info:
        await provider.search(one_way())
    assert KEY not in str(exc_info.value)


async def test_calendar_is_not_supported(provider: SerpApiFlightProvider) -> None:
    assert await provider.calendar("WAW", "BCN", date(2026, 12, 1), "EUR") == []


@respx.mock
async def test_other_airports_are_dropped(provider: SerpApiFlightProvider) -> None:
    body = recorded("oneway")
    body["best_flights"][0]["flights"][0]["departure_airport"]["id"] = "WMI"
    respx.get(URL).mock(return_value=httpx.Response(200, json=body))

    offers = await provider.search(one_way())

    assert all(o.outbound.origin == "WAW" for o in offers)
    assert len(offers) == 3


@respx.mock
async def test_nearby_airports_go_into_the_same_request(
    provider: SerpApiFlightProvider,
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=NO_RESULTS))

    await provider.search(one_way(origin_radius_km=150))

    assert route.call_count == 1  # сусідні аеропорти не коштують додаткових запитів
    assert route.calls.last.request.url.params["departure_id"] == "WAW,WMI,LCJ"
    assert route.calls.last.request.url.params["arrival_id"] == "BCN"
