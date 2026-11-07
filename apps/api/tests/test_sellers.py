"""Продавці рейсу (модуль 3) на ЗАПИСАНИХ відповідях SerpApi (fixtures/serpapi/booking_*.json)."""

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from flight_fakes import FakeRedis, StubProvider, offers_for
from httpx import AsyncClient
from tickets_api.domain.flights import FlightQuery
from tickets_api.domain.sellers import GOOGLE_BOOKING_URL, SellersRequest
from tickets_api.providers.cached import CachedFlightProvider
from tickets_api.providers.serpapi import SEARCH_PATH, SerpApiFlightProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService, flight_key, offer_groups

BASE = "https://serp.test"
URL = f"{BASE}{SEARCH_PATH}"
NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
FIXTURES = Path(__file__).parent / "fixtures" / "serpapi"
QUERY = FlightQuery(origin="WAW", destination="BCN", departure_date=date(2026, 12, 13))


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    body.pop("_meta", None)
    return body


@pytest.fixture
async def provider() -> Any:
    async with httpx.AsyncClient() as client:
        yield SerpApiFlightProvider(
            client, "secret", airports=default_airport_directory(), base_url=BASE, clock=lambda: NOW
        )


@respx.mock
async def test_search_keeps_booking_token_status_and_cabin(provider: SerpApiFlightProvider) -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("booking_search")))

    offers = await provider.search(QUERY)

    wizz = next(o for o in offers if o.outbound.flight_number == "W61475")
    assert wizz.booking_ref
    assert (wizz.price_status, wizz.cabin) == ("live", "economy")


@respx.mock
async def test_sellers_of_legacy_airline(provider: SerpApiFlightProvider) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("booking_legacy")))

    sellers = await provider.sellers(QUERY, "token-123")

    params = route.calls.last.request.url.params
    assert (params["booking_token"], params["type"], params["outbound_date"]) == (
        "token-123",
        "2",
        "2026-12-13",
    )
    assert [(s.seller, s.is_airline, int(s.price)) for s in sellers] == [
        ("LOT", True, 123),  # у пошуку було 121 € — ось навіщо перевірка перед переходом
        ("Gotogate", False, 143),
        ("lastminute.com", False, 159),
    ]
    assert sellers[2].included == ["1 free carry-on", "1st checked bag free"]
    link = sellers[0].link
    assert link is not None
    assert (link.url, link.method) == (GOOGLE_BOOKING_URL, "POST")
    assert link.post_data
    assert link.post_data.startswith("u=")
    assert sellers[0].checked_at == NOW


@respx.mock
async def test_sellers_without_baggage_info_and_cache(provider: SerpApiFlightProvider) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("booking_lowcost")))
    cached = CachedFlightProvider(provider, FakeRedis(), ttl_s=1800)  # type: ignore[arg-type]

    first = await cached.sellers(QUERY, "t")
    again = await cached.sellers(QUERY, "t")

    assert [(s.seller, int(s.price), s.included) for s in first] == [
        ("Wizz Air", 48, []),  # умов багажу джерело не дало — «невідомо»
        ("Gotogate", 68, []),
    ]
    assert again == first
    assert route.call_count == 1  # повторне відкриття картки квоту не витрачає


async def test_source_without_sellers_is_unsupported() -> None:
    svc = FlightSearchService(
        [StubProvider("cached", offers=[])], timeout_s=0.2, scoring_config=default_scoring_config()
    )
    result = await svc.sellers(SellersRequest(query=QUERY, source="cached", booking_ref="x"))
    assert (result.status, result.sellers) == ("unsupported", [])
    unknown = await svc.sellers(SellersRequest(query=QUERY, source="nope", booking_ref="x"))
    assert unknown.status == "unsupported"


async def test_sellers_endpoint(client: AsyncClient) -> None:
    body = {"query": QUERY.model_dump(mode="json"), "source": "mock", "booking_ref": "x"}
    response = await client.post("/flights/sellers", json=body)
    assert response.status_code == 200
    assert response.json()["status"] == "unsupported"  # mock продавців не має


def test_same_flight_from_two_sources_is_one_group() -> None:
    serp, tp, other = offers_for("serpapi", [130, 125, 200])
    tp = tp.model_copy(update={"source": "travelpayouts", "id": "tp-1"})
    serp = serp.model_copy(
        update={"outbound": serp.outbound.model_copy(update={"flight_number": "W6 1475"})}
    )
    tp = tp.model_copy(
        update={"outbound": tp.outbound.model_copy(update={"flight_number": "W61475"})}
    )
    other = other.model_copy(
        update={"outbound": other.outbound.model_copy(update={"flight_number": "LO437"})}
    )

    assert flight_key(serp) == flight_key(tp) == "W61475@2026-11-10T06:00/0"
    [group] = offer_groups([serp, tp, other])
    assert group.offer_keys == ["travelpayouts:tp-1", "serpapi:serpapi-0"]  # від найдешевшої
    assert (
        flight_key(
            other.model_copy(
                update={"outbound": other.outbound.model_copy(update={"flight_number": None})}
            )
        )
        is None
    )
    assert offer_groups([serp]) == []  # один продавець — не імітуємо порівняння
    assert Decimal(125) == tp.price
