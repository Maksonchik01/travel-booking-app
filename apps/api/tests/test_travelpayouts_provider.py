"""Адаптер Travelpayouts проти змоканого HTTP на ЗАПИСАНИХ реальних відповідях.

Фікстури: tests/fixtures/travelpayouts/*.json (записано 2026-11-02, скорочено).
Синтетичні рядки для крайніх випадків будуються з реального рядка через `ticket(...)`.
"""

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
)
from tickets_api.providers.travelpayouts import (
    GROUPED_PRICES,
    PRICES_FOR_DATES,
    TravelpayoutsFlightProvider,
)
from tickets_api.reference.airports import default_airport_directory

BASE = "https://tp.test"
FIXTURES = Path(__file__).parent / "fixtures" / "travelpayouts"


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    body.pop("_meta", None)
    return body


NOW = datetime(2026, 10, 26, 12, 0, 30, 123, tzinfo=UTC)


def ticket(**overrides: Any) -> dict[str, Any]:
    """Перший реальний рядок (WAW→LIS туди-назад, обидва напрямки прямі) + зміни."""
    row: dict[str, Any] = dict(recorded("prices_for_dates_rt")["data"][0])
    row.update(overrides)
    return row


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


@pytest.fixture
def provider(client: httpx.AsyncClient) -> TravelpayoutsFlightProvider:
    return TravelpayoutsFlightProvider(
        client, "secret-token", marker="12345", base_url=BASE, clock=lambda: NOW
    )


def query(**overrides: Any) -> FlightQuery:
    data: dict[str, Any] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 12, 5),
        "return_date": date(2026, 12, 12),
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


def ok(data: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "currency": "eur", "data": data})


@respx.mock
async def test_maps_recorded_round_trip(provider: TravelpayoutsFlightProvider) -> None:
    route = respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(
        return_value=httpx.Response(200, json=recorded("prices_for_dates_rt"))
    )

    offers = await provider.search(query())

    request = route.calls.last.request
    assert request.headers["X-Access-Token"] == "secret-token"
    assert dict(request.url.params) == {
        "origin": "WAW",
        "destination": "LIS",
        "departure_at": "2026-12-05",
        "return_at": "2026-12-12",
        "currency": "eur",
        "sorting": "price",
        "limit": "100",
        "one_way": "false",
    }
    # Без гнучкості лишаються лише рядки на точні дати: 05.12 → 12.12.
    [offer] = offers
    assert offer.source == "travelpayouts"
    assert (offer.price, offer.currency) == (Decimal(97), "EUR")
    assert offer.details_level == "summary"
    assert offer.collected_at == NOW.replace(microsecond=0)
    assert offer.found_at is None
    assert offer.found_on == date(2026, 10, 30)  # search_date=30102026 у посиланні
    assert offer.seller == "Kiwi.com"
    assert offer.airlines == ["FR"]
    # Фактичний аеропорт вильоту — Модлін, хоча шукали місто WAW.
    assert (offer.outbound.origin, offer.outbound.destination) == ("WMI", "LIS")
    assert (offer.outbound.stops, offer.outbound.duration_min) == (0, 260)
    assert offer.outbound.flight_number == "FR2263"
    assert offer.outbound.departure_at.isoformat() == "2026-12-05T15:25:00+01:00"
    assert offer.outbound.layovers is None
    assert offer.inbound is not None
    assert (offer.inbound.origin, offer.inbound.destination) == ("LIS", "WAW")
    assert (offer.inbound.stops, offer.inbound.duration_min) == (0, 245)
    assert offer.total_duration_min == 505
    assert offer.deep_link is not None
    assert offer.deep_link.startswith("https://www.aviasales.com/search/WAW0512LIS12121?t=")
    assert offer.deep_link.endswith("&marker=12345")


@respx.mock
async def test_layover_ground_time_goes_to_the_leg_with_stops(
    provider: TravelpayoutsFlightProvider,
) -> None:
    # Реальний рядок: туди прямо (260 хв у повітрі), назад з пересадкою (365 у повітрі),
    # duration=1150 → наземний час 525 хв належить зворотному напрямку.
    row = recorded("prices_for_dates_rt")["data"][2]
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([row]))

    [offer] = await provider.search(
        query(departure_date=date(2026, 12, 7), return_date=date(2026, 12, 10))
    )

    assert offer.outbound.duration_min == 260
    assert offer.inbound is not None
    assert offer.inbound.duration_min == 365 + 525
    assert offer.total_duration_min == 1150


@respx.mock
async def test_one_way_with_transfer_uses_full_duration(
    provider: TravelpayoutsFlightProvider,
) -> None:
    # Реальний рядок: 1 пересадка, duration_to=295 (повітря), duration=3995 (з пересадкою).
    row = recorded("prices_for_dates_ow")["data"][1]
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([row]))

    [offer] = await provider.search(
        query(destination="BCN", departure_date=date(2026, 12, 10), return_date=None)
    )

    assert (offer.outbound.origin, offer.outbound.stops) == ("WAW", 1)
    assert offer.outbound.duration_min == 3995
    assert offer.total_duration_min == 3995


@respx.mock
async def test_stops_on_both_legs_keep_only_total_duration(
    provider: TravelpayoutsFlightProvider,
) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(
        return_value=ok([ticket(transfers=1, return_transfers=1, duration=1400)])
    )

    [offer] = await provider.search(query())

    assert offer.outbound.duration_min is None
    assert offer.inbound is not None
    assert offer.inbound.duration_min is None
    assert offer.total_duration_min == 1400


@respx.mock
async def test_one_way_direct_params(provider: TravelpayoutsFlightProvider) -> None:
    route = respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([]))

    assert await provider.search(query(return_date=None, direct_only=True)) == []
    params = route.calls.last.request.url.params
    assert (params["one_way"], params["direct"]) == ("true", "true")
    assert "return_at" not in params


@respx.mock
async def test_flex_queries_months_and_filters_window(
    provider: TravelpayoutsFlightProvider,
) -> None:
    rows = [
        ticket(departure_at="2026-10-30T10:00:00+01:00"),  # вікно 29.10–4.11
        ticket(departure_at="2026-11-04T10:00:00+01:00"),  # в вікні
        ticket(departure_at="2026-11-06T10:00:00+01:00"),  # поза вікном
    ]
    route = respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok(rows))

    offers = await provider.search(
        query(departure_date=date(2026, 11, 1), return_date=None, flex_days=3)
    )

    months = [c.request.url.params["departure_at"] for c in route.calls]
    assert months == ["2026-10", "2026-11"]
    # Дві місячні відповіді однакові — дублікати зливаються за id.
    assert sorted(o.outbound.departure_at.day for o in offers) == [4, 30]


@respx.mock
async def test_skips_malformed_rows(provider: TravelpayoutsFlightProvider) -> None:
    rows = [
        ticket(price=None),
        ticket(departure_at="2026-12-05T15:25:00"),  # без поясу — не вгадуємо
        ticket(return_at=None),  # round trip без зворотної дати
        "garbage",
        ticket(price=150),
    ]
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok(rows))

    offers = await provider.search(query())

    assert [o.price for o in offers] == [Decimal(150)]


@pytest.mark.parametrize(
    "link",
    ["https://evil.example/x", "//evil.example/x", "@evil.example/x", None, 42],
)
@respx.mock
async def test_rejects_links_that_could_change_host(
    provider: TravelpayoutsFlightProvider, link: object
) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([ticket(link=link)]))

    [offer] = await provider.search(query())

    assert offer.deep_link is None


@pytest.mark.parametrize(
    ("response", "error", "message"),
    [
        (httpx.Response(429), ProviderRateLimitedError, "429"),
        (httpx.Response(401), ProviderError, "auth failed"),
        (httpx.Response(502), ProviderError, "HTTP 502"),
        (httpx.Response(200, text="<html>"), ProviderError, "invalid JSON"),
        (httpx.Response(200, json={"success": False, "error": "x"}), ProviderError, "unsucc"),
    ],
)
@respx.mock
async def test_http_failures_become_provider_errors(
    provider: TravelpayoutsFlightProvider,
    response: httpx.Response,
    error: type[ProviderError],
    message: str,
) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=response)

    with pytest.raises(error, match=message) as exc_info:
        await provider.search(query())
    assert "secret-token" not in str(exc_info.value)


@respx.mock
async def test_network_timeout(provider: TravelpayoutsFlightProvider) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(side_effect=httpx.ReadTimeout("slow"))

    with pytest.raises(ProviderError, match="timeout"):
        await provider.search(query())


@respx.mock
async def test_calendar(provider: TravelpayoutsFlightProvider) -> None:
    body = recorded("grouped_prices")
    body["data"]["2027-01-01"] = {"price": 10, "transfers": 0}  # чужий місяць
    body["data"]["bad"] = {"price": 10}
    route = respx.get(f"{BASE}{GROUPED_PRICES}").mock(return_value=httpx.Response(200, json=body))

    days = await provider.calendar("waw", "bcn", date(2026, 12, 15), "EUR")

    params = route.calls.last.request.url.params
    assert (params["origin"], params["departure_at"], params["group_by"]) == (
        "WAW",
        "2026-12",
        "departure_at",
    )
    assert [(d.date.day, d.price, d.stops, d.airline) for d in days] == [
        (1, Decimal(46), 0, "W6"),
        (2, Decimal(42), 0, "W6"),
        (3, Decimal(42), 0, "FR"),
        (4, Decimal(61), 0, "FR"),
        (5, Decimal(29), 0, "FR"),
    ]
    assert days[1].found_on == date(2026, 11, 1)


@respx.mock
async def test_only_requested_airport_with_directory(client: httpx.AsyncClient) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(
        return_value=httpx.Response(200, json=recorded("prices_for_dates_rt"))
    )
    provider = TravelpayoutsFlightProvider(
        client, "secret-token", airports=default_airport_directory(), base_url=BASE
    )

    # API шукає по місту WAW і повертає рейс із Модліна (WMI) — обрано аеропорт WAW.
    assert await provider.search(query()) == []


@respx.mock
async def test_adults_share_one_fare(provider: TravelpayoutsFlightProvider) -> None:
    respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([ticket(price=100)]))

    offers = await provider.search(query(passengers={"adults": 3}))

    # Тариф дорослого однаковий — множимо лише дорослих (ADR 0013).
    assert [o.price for o in offers] == [Decimal(300)]


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"passengers": {"adults": 1, "children": 1}}, "passengers"),
        ({"passengers": {"adults": 1, "infants": 1}}, "passengers"),
        ({"cabin": "business"}, "cabin"),
    ],
)
async def test_child_fares_and_cabins_are_unsupported_not_guessed(
    provider: TravelpayoutsFlightProvider, overrides: dict[str, Any], reason: str
) -> None:
    with pytest.raises(ProviderUnsupportedError) as exc:
        await provider.search(query(**overrides))
    assert exc.value.message == reason


@respx.mock
async def test_period_mode_queries_whole_months(provider: TravelpayoutsFlightProvider) -> None:
    route = respx.get(f"{BASE}{PRICES_FOR_DATES}").mock(return_value=ok([]))

    await provider.search(
        query(
            departure_date=date(2026, 12, 20),
            return_date=date(2026, 12, 24),
            departure_until=date(2027, 1, 10),
        )
    )

    # Період 20.12–10.01, повернення на 4 дні пізніше: місяці вильоту × місяці повернення.
    params = [
        (c.request.url.params["departure_at"], c.request.url.params["return_at"])
        for c in route.calls
    ]
    assert params == [
        ("2026-12", "2026-12"),
        ("2026-12", "2027-01"),
        ("2027-01", "2026-12"),
        ("2027-01", "2027-01"),
    ]
