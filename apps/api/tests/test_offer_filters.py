from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError
from tickets_api.domain.flights import HourRange, Layover, Leg, Offer, OfferFilters

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
        # Межі з ТЗ: ранок 05–12, день 12–17, вечір 17–22, ніч 22–05.
        (4, ["night"], True),
        (5, ["night"], False),
        (5, ["morning"], True),
        (16, ["afternoon"], True),
        (17, ["afternoon"], False),
        (21, ["evening"], True),
        (22, ["night"], True),
        (10, ["morning", "evening"], True),
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


def timed(
    dep: tuple[int, int],
    arr: tuple[int, int] | None,
    back: tuple[int, int] | None = None,
    *,
    layovers: list[Layover] | None = None,
    airlines: list[str] | None = None,
    price: int = 100,
) -> Offer:
    """Пропозиція з часом вильоту й прибуття (година, день) туди й, можливо, назад."""

    def at(hour_day: tuple[int, int]) -> datetime:
        return datetime(2026, 12, hour_day[1], hour_day[0], 15, tzinfo=WARSAW_WINTER)

    def leg(d: tuple[int, int], a: tuple[int, int] | None, lays: list[Layover] | None) -> Leg:
        return Leg(
            origin="WAW",
            destination="LIS",
            departure_at=at(d),
            arrival_at=at(a) if a else None,
            stops=len(lays) if lays is not None else 0,
            layovers=lays,
        )

    return Offer(
        id="t",
        source="t",
        price=Decimal(price),
        currency="EUR",
        outbound=leg(dep, arr, layovers),
        inbound=leg(back, (back[0] + 3, back[1]), None) if back else None,
        airlines=airlines or ["FR"],
        details_level="full",
        collected_at=datetime(2026, 11, 4, tzinfo=UTC),
    )


def test_arrival_and_return_times_are_separate() -> None:
    trip = timed(dep=(7, 5), arr=(23, 5), back=(18, 12))
    assert OfferFilters(arrival_periods=["night"]).matches(trip)
    assert not OfferFilters(arrival_periods=["morning"]).matches(trip)
    assert OfferFilters(return_departure_periods=["evening"]).matches(trip)
    assert not OfferFilters(return_departure_periods=["morning"]).matches(trip)
    # Повернення 18:00 + 3 год = прибуття 21:00 — вечір.
    assert OfferFilters(return_arrival_periods=["evening"]).matches(trip)
    # В один бік фільтри повернення не діють.
    assert OfferFilters(return_departure_periods=["morning"]).matches(timed((7, 5), (9, 5)))


def test_custom_hour_range_wraps_midnight_and_unknown_time_passes() -> None:
    late = OfferFilters(departure_hours=HourRange(start=21, end=2))
    assert late.matches(timed((23, 5), None))
    assert late.matches(timed((1, 5), None))
    assert not late.matches(timed((7, 5), None))
    # Час прибуття невідомий — фільтр прибуття не відсікає (ADR 0004).
    assert OfferFilters(arrival_hours=HourRange(start=8, end=12)).matches(timed((7, 5), None))
    # Частини доби АБО власний діапазон.
    either = OfferFilters(
        departure_periods=["morning"], departure_hours=HourRange(start=20, end=22)
    )
    assert either.matches(timed((20, 5), None))
    with pytest.raises(ValidationError):
        HourRange(start=5, end=5)


def test_layover_limits_regular_and_self_transfer() -> None:
    def lay(minutes: int, self_transfer: bool | None) -> Layover:
        return Layover(
            airport="FRA", duration_min=minutes, overnight=False, self_transfer=self_transfer
        )

    short_regular = timed((7, 5), (12, 5), layovers=[lay(50, False)])
    short_self = timed((7, 5), (12, 5), layovers=[lay(120, True)])
    unknown_kind = timed((7, 5), (12, 5), layovers=[lay(50, None)])
    long_one = timed((7, 5), (23, 5), layovers=[lay(600, False)])

    f = OfferFilters(min_layover_min=60, min_self_transfer_min=180)
    assert not f.matches(short_regular)
    assert not f.matches(short_self)  # 2 год на окремих квитках — замало
    assert not f.matches(unknown_kind)  # невідомо, чи окремі квитки, — як звичайна
    assert f.matches(long_one)
    assert not OfferFilters(max_layover_hours=6).matches(long_one)
    # Пересадки невідомі (layovers=None) — не відсікаємо.
    assert OfferFilters(max_layover_hours=1).matches(offer(stops=(1, None)))


def test_excluded_airlines_and_total_budget() -> None:
    assert not OfferFilters(excluded_airlines=["fr"]).matches(
        timed((7, 5), None, airlines=["FR", "LO"])
    )
    assert OfferFilters(excluded_airlines=["W6"]).matches(timed((7, 5), None, airlines=["FR"]))
    trio = timed((7, 5), None, price=300)
    assert OfferFilters(max_total_price=300).matches(trio, passengers=3)
    assert not OfferFilters(max_total_price=299).matches(trio, passengers=3)
    assert OfferFilters(max_price=100).matches(trio, passengers=3)
