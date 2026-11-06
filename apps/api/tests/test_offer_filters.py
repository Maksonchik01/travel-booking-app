from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError
from tickets_api.domain.flights import Leg, Offer, OfferFilters

WARSAW_WINTER = timezone(timedelta(hours=1))


def offer(
    *,
    hour: int = 10,
    stops: tuple[int, int | None] = (0, None),
    durations: tuple[int | None, int | None] = (240, None),
    airlines: list[str] | None = None,
) -> Offer:
    def leg(stops_n: int, duration: int | None, day: int) -> Leg:
        return Leg(
            origin="WAW",
            destination="LIS",
            departure_at=datetime(2026, 12, day, hour, 30, tzinfo=WARSAW_WINTER),
            duration_min=duration,
            stops=stops_n,
        )

    return Offer(
        id="x",
        source="t",
        price=Decimal(100),
        currency="EUR",
        outbound=leg(stops[0], durations[0], 5),
        inbound=leg(stops[1], durations[1], 12) if stops[1] is not None else None,
        airlines=["FR"] if airlines is None else airlines,
        details_level="summary",
        collected_at=datetime(2026, 11, 4, tzinfo=UTC),
    )


def test_no_filters_keep_everything() -> None:
    assert OfferFilters().matches(offer(stops=(2, 3)))


def test_max_stops_is_per_direction() -> None:
    one_each = offer(stops=(1, 1))
    assert OfferFilters(max_stops=1).matches(one_each)
    assert not OfferFilters(max_stops=0).matches(one_each)
    assert not OfferFilters(max_stops=1).matches(offer(stops=(0, 2)))


def test_airlines_all_carriers_must_be_selected() -> None:
    assert OfferFilters(airlines=["fr", "W6"]).matches(offer(airlines=["FR"]))
    assert not OfferFilters(airlines=["FR"]).matches(offer(airlines=["FR", "LO"]))
    assert OfferFilters(airlines=["FR"]).matches(offer(airlines=[]))  # невідомо — не відсікаємо


@pytest.mark.parametrize(
    ("hour", "periods", "expected"),
    [
        (5, ["night"], True),
        (6, ["night"], False),
        (10, ["morning", "evening"], True),
        (23, ["evening"], True),
    ],
)
def test_departure_period_uses_local_airport_time(
    hour: int, periods: list[str], expected: bool
) -> None:
    assert (
        OfferFilters.model_validate({"departure_periods": periods}).matches(offer(hour=hour))
        is expected
    )


def test_max_duration_checks_longest_leg_and_keeps_unknown() -> None:
    f = OfferFilters(max_duration_hours=5)
    assert f.matches(offer(durations=(300, None)))
    assert not f.matches(offer(stops=(0, 0), durations=(240, 301)))
    assert f.matches(offer(durations=(None, None)))


def test_rejects_garbage() -> None:
    with pytest.raises(ValidationError):
        OfferFilters.model_validate({"airlines": ["RYANAIR"]})
    with pytest.raises(ValidationError):
        OfferFilters.model_validate({"departure_periods": ["brunch"]})


def test_max_price() -> None:
    assert OfferFilters(max_price=100).matches(offer())
    assert not OfferFilters(max_price=99).matches(offer())
