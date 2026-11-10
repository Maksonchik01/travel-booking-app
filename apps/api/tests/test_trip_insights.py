"""Порівняння варіантів поїздки (етап 4, ADR 0048): відмінності, «краще в бюджеті», підказки,
корисний час у місті, дорога до аеропорту."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from test_trip_planner import QUERY, planner
from tickets_api.domain.stays import Stay
from tickets_api.services.trip_insights import (
    Comparable,
    better_within_budget,
    differences,
    recommendations,
)
from tickets_api.services.trip_planner import comparable

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)


def stay(sid: str, rating: str | None, km: str | None = "1.0") -> Stay:
    return Stay(
        id=sid,
        source="mock",
        name=sid,
        kind="hotel",
        price_per_night=Decimal(100),
        total_price=Decimal(300),
        currency="EUR",
        nights=3,
        rating=Decimal(rating) if rating else None,
        review_count=100,
        distance_to_center_km=Decimal(km) if km else None,
        collected_at=NOW,
    )


def combo(key: str, stay_index: int, **overrides: Any) -> Comparable:
    data: dict[str, Any] = {
        "key": key,
        "offer_key": "mock:f1",
        "stay_key": f"mock:{key}",
        "stay_index": stay_index,
        "money_total": Decimal(500),
        "unknown": 0,
        "stops": 1,
        "travel_min": 600,
        "city_minutes": 3000,
        "full_nights": 3,
        "check_in": date(2026, 12, 5),
        "check_out": date(2026, 12, 8),
    }
    data.update(overrides)
    return Comparable.model_validate(data)


STAYS = [stay("a", "8.0", "2.0"), stay("b", "8.9", "0.8"), stay("c", "7.0")]


def codes(diffs: list[Any]) -> dict[str, Any]:
    return {d.code: d for d in diffs}


def test_differences_are_concrete_facts() -> None:
    current = combo("a", 0)
    other = combo(
        "b",
        1,
        money_total=Decimal(465),
        stops=0,
        travel_min=420,
        city_minutes=3360,
        check_in=date(2026, 12, 4),
    )

    found = codes(differences(current, STAYS[0], other, STAYS[1]))

    assert found["cheaper"].amount == Decimal(35)
    assert found["direct"].count == 1  # прямий рейс замість пересадки
    assert found["faster"].minutes == 180
    assert found["more_city_time"].minutes == 360
    assert found["earlier"].days == 1
    assert found["higher_rating"].rating == Decimal("0.9")
    assert found["closer"].km == Decimal("1.2")
    # Дрібниці (менше порогів) — не відмінність.
    same = combo("a2", 0, money_total=Decimal("500.40"), travel_min=610)
    assert differences(current, STAYS[0], same, STAYS[0]) == []


def test_better_within_budget_or_not_pricier_than_current() -> None:
    current = combo("a", 0)
    direct_pricier = combo("b", 1, stops=0, money_total=Decimal(560))
    worse_cheaper = combo("c", 2, stops=2, money_total=Decimal(300))
    unknown_cost = combo("d", 1, stops=0, money_total=Decimal(450), unknown=1)
    pool = [current, direct_pricier, worse_cheaper, unknown_cost]

    # Без бюджету — не дорожче за поточний: прямого за 560 немає, невідома сума — не пропонуємо.
    assert better_within_budget(current, pool, STAYS, None) is None
    # Бюджет 600 — прямий рейс з кращим житлом підходить.
    better = better_within_budget(current, pool, STAYS, 600)
    assert better is not None
    assert better.combo_key == "b"
    assert better.kind == "better"
    assert {d.code for d in better.differences} >= {"pricier", "direct", "higher_rating"}


def test_recommendations_up_to_two_from_real_combos() -> None:
    current = combo("a", 0)
    cheaper_dates = combo(
        "x", 0, money_total=Decimal(458), check_in=date(2026, 12, 4), check_out=date(2026, 12, 7)
    )
    more_time = combo("y", 0, city_minutes=3300, money_total=Decimal(510))
    nicer_stay = combo("z", 1, money_total=Decimal(505))

    hints = recommendations(current, [current, cheaper_dates, more_time, nicer_stay], STAYS)

    assert [h.kind for h in hints] == ["cheaper_dates", "more_city_time"]
    assert codes(hints[0].differences)["cheaper"].amount == Decimal(42)
    assert codes(hints[1].differences)["more_city_time"].minutes == 300
    # Економія менша за поріг (5 % чи 10 €) — не підказка.
    tiny = combo("t", 0, money_total=Decimal(495), check_in=date(2026, 12, 6))
    assert recommendations(current, [current, tiny], STAYS) == []


async def test_planner_gives_city_time_insights_and_airport_road() -> None:
    query = QUERY.model_copy(update={"airport_road": Decimal(40), "budget_total": 5000})
    result = await planner().plan(query)

    assert result.base_key is not None
    base = next(c for c in result.combos if c.key == result.base_key)
    assert base.arrival_at is not None  # mock знає час прильоту
    assert base.city_minutes == int(
        (base.return_departure_at - base.arrival_at).total_seconds() // 60
    )
    road = [i for i in base.costs.items if i.kind == "airport"]
    assert [(i.amount, i.status) for i in road] == [(Decimal(40), "approximate")]
    assert base.money_total == base.costs.confirmed + base.costs.approximate
    for alt in [result.better, *result.recommendations]:
        if alt is not None:
            assert alt.combo_key in {c.key for c in result.combos}
            assert alt.combo_key != result.base_key
    assert len(result.recommendations) <= 2
    assert comparable(base).money_total == base.money_total


async def test_cheaper_reports_differences() -> None:
    base = await planner().plan(QUERY)
    flight = max(base.flight_options, key=lambda f: f.flight_total).offer_key
    result = await planner().cheaper(QUERY.model_copy(update={"flight": flight}))

    assert result.status == "found"
    assert result.differences
    assert result.differences[0].code == "cheaper"
    assert result.differences[0].amount == result.saving
