from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError
from tickets_api.domain.flights import FlightQuery, Layover, Leg, Offer, Passengers

T0 = datetime(2026, 11, 5, 8, 0, tzinfo=UTC)


def make_leg(stops: int = 0, **overrides: object) -> Leg:
    data: dict[str, object] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_at": T0,
        "duration_min": 240,
        "stops": stops,
    }
    data.update(overrides)
    return Leg.model_validate(data)


def test_query_normalizes_codes_and_defaults_to_eur() -> None:
    query = FlightQuery(origin="waw", destination="lis", departure_date=date(2026, 11, 5))

    assert (query.origin, query.destination, query.currency) == ("WAW", "LIS", "EUR")
    assert query.passengers == Passengers(adults=1)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"destination": "WAW"}, "збігаються"),
        ({"return_date": date(2026, 11, 1)}, "раніша"),
        ({"flex_days": 8}, "less than or equal"),
        ({"origin": "WA"}, "pattern"),
        ({"unknown": 1}, "Extra inputs"),
    ],
)
def test_query_rejects_invalid_input(overrides: dict[str, object], message: str) -> None:
    data: dict[str, object] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 11, 5),
    }
    data.update(overrides)

    with pytest.raises(ValidationError, match=message):
        FlightQuery.model_validate(data)


def test_passengers_rules() -> None:
    with pytest.raises(ValidationError, match="немовлят"):
        Passengers(adults=1, infants=2)
    with pytest.raises(ValidationError, match="не більше 9"):
        Passengers(adults=5, children=5)


def test_flex_windows() -> None:
    query = FlightQuery(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 11, 5),
        return_date=date(2026, 11, 12),
        flex_days=3,
    )

    assert query.departure_window == (date(2026, 11, 2), date(2026, 11, 8))
    assert query.return_window == (date(2026, 11, 9), date(2026, 11, 15))


def test_leg_details_must_match_stop_count() -> None:
    layover = Layover(airport="FRA", duration_min=50, overnight=False, self_transfer=False)

    with pytest.raises(ValidationError, match="layovers"):
        make_leg(stops=2, layovers=[layover])
    assert make_leg(stops=1, layovers=[layover]).layovers == [layover]
    assert make_leg(stops=1).layovers is None  # деталі невідомі — це допустимо


def test_offer_totals_and_json_shape() -> None:
    offer = Offer(
        id="x",
        source="test",
        price=Decimal("123.40"),
        currency="eur",
        outbound=make_leg(stops=1, duration_min=300),
        inbound=make_leg(stops=0, duration_min=200, origin="LIS", destination="WAW"),
        airlines=["LO"],
        details_level="summary",
        collected_at=T0,
    )

    dumped = offer.model_dump(mode="json")
    assert dumped["price"] == 123.4
    assert dumped["currency"] == "EUR"
    assert dumped["stops"] == 1
    assert dumped["total_duration_min"] == 500
    # JSON з обчислюваними полями читається назад (потрібно кешу).
    assert Offer.model_validate(dumped) == offer


def test_total_duration_unknown_if_any_leg_unknown() -> None:
    offer = Offer(
        id="x",
        source="test",
        price=Decimal(100),
        currency="EUR",
        outbound=make_leg(duration_min=None),
        airlines=[],
        details_level="summary",
        collected_at=T0,
    )

    assert offer.total_duration_min is None


def test_reported_total_duration_used_when_legs_unknown() -> None:
    offer = Offer(
        id="x",
        source="test",
        price=Decimal(100),
        currency="EUR",
        outbound=make_leg(stops=1, duration_min=None),
        inbound=make_leg(stops=1, duration_min=None, origin="LIS", destination="WAW"),
        airlines=[],
        details_level="summary",
        collected_at=T0,
        reported_total_duration_min=1400,
    )

    assert offer.total_duration_min == 1400
