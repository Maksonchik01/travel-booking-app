"""Умови спрацювання підписок (модуль 11a) і перевірка вхідних даних. Без БД."""

from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError
from tickets_api.db.models import Alert
from tickets_api.domain.alerts import AlertCreate, triggered
from tickets_api.services.alert_sources import trip_price_source
from tickets_api.services.alerts import Found, route_text


def fires(condition: str, best: int, **kw: object) -> bool:
    args: dict[str, object] = {
        "threshold": None,
        "percent": None,
        "baseline": None,
        "previous": None,
    }
    args.update(kw)
    return triggered(condition, best=Decimal(best), **args)  # type: ignore[arg-type]


def test_below_price_and_significant_repeat() -> None:
    assert fires("below_price", 100, threshold=100)
    assert not fires("below_price", 101, threshold=100)
    assert not fires("below_price", 98, threshold=100, previous=Decimal(100))  # −2%
    assert fires("below_price", 97, threshold=100, previous=Decimal(100))  # −3%


def test_drop_amount_and_percent_from_baseline() -> None:
    base = Decimal(200)
    assert not fires("drop_amount", 200, threshold=30, baseline=base)
    assert fires("drop_amount", 170, threshold=30, baseline=base)
    assert not fires("drop_amount", 150, threshold=30, baseline=base, previous=Decimal(170))
    assert fires("drop_amount", 140, threshold=30, baseline=base, previous=Decimal(170))
    assert not fires("drop_amount", 100, threshold=30, baseline=None)  # бази ще немає
    assert fires("drop_percent", 180, percent=10, baseline=base)
    assert not fires("drop_percent", 181, percent=10, baseline=base)
    assert not fires("drop_percent", 170, percent=10, baseline=base, previous=Decimal(180))


def test_below_typical_needs_history() -> None:
    assert not fires("below_typical", 50)
    assert fires("below_typical", 50, typical_limit=Decimal(60))


def body(**kw: object) -> dict[str, object]:
    base: dict[str, object] = {
        "origin": "AMS",
        "destination": "WAW",
        "departure_date": date(2026, 12, 1),
        "threshold": 100,
    }
    base.update(kw)
    return base


def test_create_validation() -> None:
    flex = AlertCreate.model_validate(
        body(kind="flex", departure_until=date(2026, 12, 31), min_nights=1, max_nights=3)
    )
    assert flex.weekends is False
    bad = [
        body(kind="flex", departure_until=date(2026, 12, 31)),  # без тривалості
        body(kind="flex", departure_until=date(2027, 3, 1), min_nights=1),  # > 62 днів
        body(kind="flex", departure_until=date(2026, 12, 31), min_nights=3, max_nights=2),
        body(weekends=True),  # вихідні — лише для гнучких дат
        body(condition="drop_percent", threshold=None),
        body(condition="drop_amount", threshold=None),
        body(
            kind="flex", departure_until=date(2026, 12, 9), min_nights=2, condition="below_typical"
        ),
        body(origin=None),
        body(kind="stay", origin=None),  # житло — потрібна дата виїзду
        body(stay_key="mock:1"),
    ]
    for case in bad:
        with pytest.raises(ValidationError):
            AlertCreate.model_validate(case)
    stay = AlertCreate.model_validate(
        body(kind="stay", origin=None, return_date=date(2026, 12, 4), stay_key="mock:lis-1")
    )
    assert stay.stay_key == "mock:lis-1"


def alert(**kw: object) -> Alert:
    fields: dict[str, object] = {
        "kind": "flight",
        "origin": "AMS",
        "destination": "WAW",
        "departure_date": date(2026, 12, 1),
        "return_date": None,
        "departure_until": None,
        "min_nights": None,
        "max_nights": None,
        "weekends": False,
        "adults": 2,
        "baggage": "none",
    }
    fields.update(kw)
    return Alert(**fields)


def test_route_text_by_kind() -> None:
    assert route_text(alert(return_date=date(2026, 12, 5))) == "AMS → WAW, 01.12.2026 – 05.12.2026"
    assert route_text(alert(kind="stay", origin=None, return_date=date(2026, 12, 5))) == (
        "Житло: WAW, 01.12.2026 – 05.12.2026"
    )


async def test_trip_source_sums_flight_and_stay() -> None:
    async def flight(_: Alert) -> Found | None:
        return Found(Decimal(120), date(2026, 12, 1), date(2026, 12, 5), baggage_unknown=True)

    async def stay(_: Alert) -> Found | None:
        return Found(Decimal(300))

    async def nothing(_: Alert) -> Found | None:
        return None

    total = await trip_price_source(flight, stay)(alert(kind="trip"))
    assert total == Found(Decimal(420), date(2026, 12, 1), date(2026, 12, 5), True)
    assert await trip_price_source(flight, nothing)(alert(kind="trip")) is None
