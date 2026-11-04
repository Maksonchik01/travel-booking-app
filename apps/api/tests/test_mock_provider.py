from datetime import UTC, date, datetime, timedelta

import pytest
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.base import FlightProvider
from tickets_api.providers.mock import MockFlightProvider

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
ROUTES = [("WAW", "LIS"), ("KRK", "BCN"), ("BER", "ATH"), ("VIE", "OSL"), ("PRG", "MAD")]


@pytest.fixture
def provider() -> MockFlightProvider:
    return MockFlightProvider(clock=lambda: NOW)


def query(**overrides: object) -> FlightQuery:
    data: dict[str, object] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 11, 10),
    }
    data.update(overrides)
    return FlightQuery.model_validate(data)


def test_implements_protocol(provider: MockFlightProvider) -> None:
    assert isinstance(provider, FlightProvider)


async def test_is_deterministic(provider: MockFlightProvider) -> None:
    other = MockFlightProvider(clock=lambda: NOW)

    assert await provider.search(query()) == await other.search(query())


async def test_offers_are_complete_and_sorted(provider: MockFlightProvider) -> None:
    offers = await provider.search(query(return_date=date(2026, 11, 17)))

    assert offers
    assert [o.price for o in offers] == sorted(o.price for o in offers)
    for offer in offers:
        assert offer.details_level == "full"
        assert offer.inbound is not None
        assert offer.currency == "EUR"
        assert offer.collected_at == NOW
        assert offer.found_at is not None
        assert offer.found_at < NOW
        for leg in (offer.outbound, offer.inbound):
            assert leg.segments is not None
            assert leg.layovers is not None
            assert leg.segments[0].origin == leg.origin
            assert leg.segments[-1].destination == leg.destination
            assert leg.duration_min == sum(s.duration_min for s in leg.segments) + sum(
                lay.duration_min for lay in leg.layovers
            )


async def test_flex_days_stay_within_window(provider: MockFlightProvider) -> None:
    q = query(flex_days=2)
    offers = await provider.search(q)

    dates = {o.outbound.departure_at.date() for o in offers}
    assert dates == {date(2026, 11, 10) + timedelta(days=d) for d in range(-2, 3)}


async def test_direct_only_has_no_stops(provider: MockFlightProvider) -> None:
    for origin, destination in ROUTES:
        offers = await provider.search(
            query(origin=origin, destination=destination, direct_only=True)
        )
        assert all(o.stops == 0 for o in offers)


async def test_produces_risky_cases_for_scoring(provider: MockFlightProvider) -> None:
    layovers = []
    for origin, destination in ROUTES:
        offers = await provider.search(query(origin=origin, destination=destination, flex_days=3))
        layovers += [lay for o in offers for lay in o.outbound.layovers or []]

    assert any(lay.duration_min < 60 for lay in layovers)
    assert any(lay.overnight for lay in layovers)
    assert any(lay.self_transfer for lay in layovers)


async def test_uses_requested_currency_or_falls_back_to_eur(provider: MockFlightProvider) -> None:
    assert {o.currency for o in await provider.search(query(currency="UAH"))} == {"UAH"}
    assert {o.currency for o in await provider.search(query(currency="JPY"))} == {"EUR"}


async def test_calendar_covers_month(provider: MockFlightProvider) -> None:
    days = await provider.calendar("WAW", "LIS", date(2026, 11, 1), "EUR")

    assert [d.date.day for d in days] == list(range(1, 31))
    assert all(d.source == "mock" and d.currency == "EUR" for d in days)
