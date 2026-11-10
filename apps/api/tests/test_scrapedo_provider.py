"""Адаптер scrape.do Google Flights на ЗАПИСАНИХ реальних відповідях (tests/fixtures/scrapedo/)."""

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from tickets_api.core.config import Settings
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
)
from tickets_api.providers.scrapedo import FLIGHTS_PATH, ScrapeDoFlightProvider
from tickets_api.reference.airports import default_airport_directory

BASE = "https://sdo.test"
URL = f"{BASE}{FLIGHTS_PATH}"
TOKEN = "secret-sdo-token"  # noqa: S105
NOW = datetime(2026, 11, 10, 12, 0, 30, 5, tzinfo=UTC)
FIXTURES = Path(__file__).parent / "fixtures" / "scrapedo"


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return body


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


@pytest.fixture
def provider(client: httpx.AsyncClient) -> ScrapeDoFlightProvider:
    return ScrapeDoFlightProvider(
        client, TOKEN, airports=default_airport_directory(), base_url=BASE, clock=lambda: NOW
    )


def query(**overrides: Any) -> FlightQuery:
    data: dict[str, Any] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 12, 13),
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


def mock_directions() -> respx.Route:
    """Туди й назад — дві різні відповіді за напрямком запиту."""

    def respond(request: httpx.Request) -> httpx.Response:
        p = request.url.params
        name = f"one_way_{p['departure_id']}_{p['arrival_id']}_{p['outbound_date']}".lower()
        return httpx.Response(200, json=recorded(name))

    return respx.get(URL).mock(side_effect=respond)


@respx.mock
async def test_one_way_is_one_request_with_token_and_live_offers(
    provider: ScrapeDoFlightProvider,
) -> None:
    route = mock_directions()

    offers = await provider.search(query())

    assert route.call_count == 1
    params = route.calls[0].request.url.params
    assert params["token"] == TOKEN
    assert (params["departure_id"], params["arrival_id"], params["type"]) == ("WAW", "LIS", "2")
    assert offers
    assert all(o.source == "scrapedo" for o in offers)
    assert all(o.inbound is None for o in offers)
    assert [o.price for o in offers] == sorted(o.price for o in offers)
    first = offers[0]
    assert first.price_status == "live"
    assert first.details_level == "full"
    assert first.separate_tickets is False
    # Продавців scrape.do не дає — перевірки ціни в продавця немає.
    assert all(o.booking_ref is None for o in offers)
    assert first.deep_link is not None
    assert first.deep_link.startswith("https://www.google.com/travel/flights?q=")
    assert first.outbound.segments
    assert first.outbound.segments[0].departure_at.utcoffset() is not None


@respx.mock
async def test_round_trip_is_two_one_way_tickets(provider: ScrapeDoFlightProvider) -> None:
    route = mock_directions()

    offers = await provider.search(query(return_date=date(2026, 12, 20)))

    assert route.call_count == 2  # туди й назад — окремими запитами в один бік
    assert len(offers) == 25  # 5 найдешевших × 5
    there = recorded("one_way_waw_lis_2026-12-13")
    back = recorded("one_way_lis_waw_2026-12-20")
    cheapest = min(it["price"] for it in there["best_flights"] + there["other_flights"])
    cheapest_back = min(it["price"] for it in back["best_flights"] + back["other_flights"])
    assert offers[0].price == cheapest + cheapest_back
    for offer in offers:
        assert offer.separate_tickets is True
        assert offer.inbound is not None
        assert (offer.outbound.origin, offer.inbound.destination) == ("WAW", "WAW")
        assert offer.inbound.departure_at.date() == date(2026, 12, 20)
        assert offer.booking_ref is None
    assert len({o.id for o in offers}) == 25


@respx.mock
async def test_budget_stops_before_a_round_trip_without_return(client: httpx.AsyncClient) -> None:
    route = mock_directions()
    provider = ScrapeDoFlightProvider(
        client,
        TOKEN,
        airports=default_airport_directory(),
        base_url=BASE,
        clock=lambda: NOW,
        max_requests_per_search=3,
    )

    await provider.search(query(return_date=date(2026, 12, 20), flex_days=1))

    assert route.call_count == 2  # друга пара дат потребувала б ще двох запитів


@pytest.mark.parametrize(
    ("status", "error"),
    [(429, ProviderRateLimitedError), (402, ProviderRateLimitedError), (401, ProviderError)],
)
@respx.mock
async def test_errors_never_leak_token(
    provider: ScrapeDoFlightProvider, status: int, error: type[ProviderError]
) -> None:
    respx.get(URL).mock(return_value=httpx.Response(status, json={"error": f"bad {TOKEN}"}))

    with pytest.raises(error) as caught:
        await provider.search(query())

    assert TOKEN not in str(caught.value)


@respx.mock
async def test_bad_request_is_provider_error(provider: ScrapeDoFlightProvider) -> None:
    respx.get(URL).mock(
        return_value=httpx.Response(400, json={"error": "invalid search parameters"})
    )

    with pytest.raises(ProviderError, match="HTTP 400"):
        await provider.search(query())


@respx.mock
async def test_network_error_message_has_no_url(provider: ScrapeDoFlightProvider) -> None:
    respx.get(URL).mock(side_effect=httpx.ConnectError(f"failed {URL}?token={TOKEN}"))

    with pytest.raises(ProviderError) as caught:
        await provider.search(query())

    assert TOKEN not in str(caught.value)


async def test_sellers_are_unsupported(provider: ScrapeDoFlightProvider) -> None:
    with pytest.raises(ProviderUnsupportedError):
        await provider.sellers(query(), "token")


def test_settings_require_token_and_forbid_alerts() -> None:
    with pytest.raises(ValueError, match="SCRAPEDO_TOKEN"):
        Settings(_env_file=None, flight_providers=["scrapedo"])
    with pytest.raises(ValueError, match="scrapedo"):
        Settings(
            _env_file=None,
            alert_providers=["scrapedo"],
            scrapedo_token="t",  # noqa: S106
        )
    settings = Settings(
        _env_file=None,
        flight_providers=["scrapedo"],
        scrapedo_token=" t\n",  # noqa: S106
    )
    assert settings.scrapedo_token is not None
    assert settings.scrapedo_token.get_secret_value() == "t"
