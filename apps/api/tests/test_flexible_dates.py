"""Гнучкі дати (модуль 2a, ADR 0016): кешовані кандидати → жива перевірка найдешевших пар."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from flight_fakes import StubProvider, offers_for
from httpx import AsyncClient
from pydantic import ValidationError
from tickets_api.domain.flights import DatePair, FlightQuery, Offer, stay_nights
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService

FLEX = FlightQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 5),
    return_date=date(2026, 12, 12),
    flex_days=3,
)


def on(source: str, price: int, dep: date, ret: date | None, idx: int = 0) -> Offer:
    """Пропозиція на конкретні дати вильоту й повернення."""
    base = offers_for(source, [price])[0]
    out = base.outbound.model_copy(
        update={"departure_at": datetime(dep.year, dep.month, dep.day, 8, tzinfo=UTC)}
    )
    back = (
        out.model_copy(
            update={"departure_at": datetime(ret.year, ret.month, ret.day, 18, tzinfo=UTC)}
        )
        if ret
        else None
    )
    return base.model_copy(
        update={"id": f"{source}-{dep}-{ret}-{idx}", "outbound": out, "inbound": back}
    )


def service(live: StubProvider, cached: StubProvider, pairs: int = 2) -> FlightSearchService:
    return FlightSearchService(
        [live],
        calendar_providers=[cached],
        timeout_s=0.5,
        scoring_config=default_scoring_config(),
        live_date_pairs=pairs,
    )


async def test_cheapest_cached_pairs_are_checked_live() -> None:
    d = date(2026, 12, 1)
    cached = StubProvider(
        "cached",
        offers=[
            on("cached", 90, d + timedelta(days=3), d + timedelta(days=10)),
            on("cached", 80, d + timedelta(days=5), d + timedelta(days=12)),
            on("cached", 120, d + timedelta(days=6), d + timedelta(days=13)),
            on("cached", 85, d + timedelta(days=5), d + timedelta(days=12), idx=1),  # та сама пара
        ],
    )
    live = StubProvider(
        "live", offers=[on("live", 95, d + timedelta(days=5), d + timedelta(days=12))]
    )

    result = await service(live, cached).search(FLEX)

    [checked] = live.queries
    assert checked.check_dates == [
        DatePair(departure=date(2026, 12, 6), return_date=date(2026, 12, 13)),
        DatePair(departure=date(2026, 12, 4), return_date=date(2026, 12, 11)),
    ]
    # Альтернативні дати: найкраща ціна на пару, перевірена наживо чи лише кешована.
    options = [(o.departure.day, int(o.price), o.verified) for o in result.date_options]
    # 6-го кешована 80, а жива перевірка дала 95 — показуємо перевірену (модуль 22).
    assert options == [(4, 90, False), (6, 95, True), (7, 120, False)]
    assert {p.provider for p in result.providers} == {"cached", "live"}


async def test_exact_dates_do_not_touch_cached_candidates() -> None:
    cached = StubProvider("cached", offers=offers_for("cached", [50]))
    live = StubProvider("live", offers=offers_for("live", [100]))

    result = await service(live, cached).search(
        FLEX.at_dates(date(2026, 12, 5), date(2026, 12, 12))
    )

    assert cached.calls == 0
    assert live.queries[0].check_dates is None
    assert result.date_options == []


async def test_no_candidates_falls_back_to_live_window() -> None:
    cached = StubProvider("cached", offers=[])
    live = StubProvider("live", offers=[])

    await service(live, cached).search(FLEX)

    assert live.queries[0].check_dates is None  # джерело перебирає вікно саме, як раніше
    assert live.queries[0].flex_days == 3


async def test_period_keeps_trip_length_and_budget_filter_applies_to_pairs() -> None:
    period = FLEX.model_copy(
        update={
            "departure_date": date(2026, 12, 1),
            "return_date": date(2026, 12, 5),
            "flex_days": 0,
        }
    )
    period = FlightQuery.model_validate(
        {
            **period.model_dump(),
            "departure_until": date(2026, 12, 31),
            "filters": {"max_price": 100},
        }
    )
    cached = StubProvider(
        "cached",
        offers=[
            on("cached", 70, date(2026, 12, 10), date(2026, 12, 14)),  # 4 дні — як у запиті
            on("cached", 40, date(2026, 12, 11), date(2026, 12, 25)),  # 14 днів — не та поїздка
            on("cached", 150, date(2026, 12, 3), date(2026, 12, 8)),  # дорожче бюджету
        ],
    )
    live = StubProvider("live", offers=[])

    result = await service(live, cached).search(period)

    assert live.queries[0].check_dates == [
        DatePair(departure=date(2026, 12, 10), return_date=date(2026, 12, 14))
    ]
    assert [int(o.price) for o in result.offers] == [70]
    assert result.date_options[0].price == Decimal(70)


NIGHTS = FlightQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 1),
    return_date=date(2026, 12, 4),
    departure_until=date(2026, 12, 31),
    min_nights=3,
    max_nights=5,
)


def arriving(offer: Offer, arrival: datetime | None) -> Offer:
    return offer.model_copy(
        update={"outbound": offer.outbound.model_copy(update={"arrival_at": arrival})}
    )


def test_nights_query_rules_and_return_window() -> None:
    assert NIGHTS.nights_range == (3, 5)
    # Повернення — від 1.12 + 3 до 31.12 + 5 + 1 (нічний рейс прилітає наступного дня).
    assert NIGHTS.return_window == (date(2026, 12, 4), date(2027, 1, 6))
    cases: list[tuple[dict[str, Any], str]] = [
        ({"min_nights": 5, "max_nights": 3}, "більший"),
        ({"max_nights": None}, "разом"),
        ({"departure_until": None}, "гнучкого"),
    ]
    for bad, error in cases:
        with pytest.raises(ValidationError, match=error):
            FlightQuery.model_validate({**NIGHTS.model_dump(), **bad})


def test_nights_count_from_actual_arrival() -> None:
    late = on("x", 100, date(2026, 12, 10), date(2026, 12, 14))
    # Виліт 10.12 о 08:00, приліт 11.12 (нічний) → 3 ночі до вильоту назад 14.12.
    overnight = arriving(late, datetime(2026, 12, 11, 1, tzinfo=UTC))
    assert overnight.inbound is not None
    assert stay_nights(overnight.outbound, overnight.inbound) == (3, False)
    # Прибуття невідоме — від дати вильоту, орієнтовно.
    assert stay_nights(late.outbound, late.inbound) == (4, True)  # type: ignore[arg-type]


async def test_nights_filter_applies_to_live_and_cached_offers() -> None:
    d = date
    cached = StubProvider(
        "cached",
        offers=[
            on("cached", 70, d(2026, 12, 10), d(2026, 12, 14)),  # 4 ночі (орієнтовно)
            on("cached", 40, d(2026, 12, 11), d(2026, 12, 13)),  # 2 ночі — замало
            on("cached", 60, d(2026, 12, 3), d(2026, 12, 12)),  # 9 ночей — забагато
            on("cached", 65, d(2026, 12, 5), d(2026, 12, 11)),  # 6 орієнтовно → може бути 5
        ],
    )
    live = StubProvider(
        "live",
        offers=[
            # Живий рейс прилітає наступного дня: 13.12 → 15.12 — лише 2 ночі, не підходить.
            arriving(
                on("live", 50, d(2026, 12, 12), d(2026, 12, 15)),
                datetime(2026, 12, 13, 2, tzinfo=UTC),
            ),
            arriving(
                on("live", 75, d(2026, 12, 10), d(2026, 12, 14), idx=1),
                datetime(2026, 12, 10, 12, tzinfo=UTC),
            ),
        ],
    )

    result = await service(live, cached).search(NIGHTS)

    assert sorted(int(o.price) for o in result.offers) == [65, 70, 75]
    assert live.queries[0].check_dates == [
        DatePair(departure=d(2026, 12, 5), return_date=d(2026, 12, 11)),
        DatePair(departure=d(2026, 12, 10), return_date=d(2026, 12, 14)),
    ]
    nights = {(o.departure.day, o.nights, o.nights_approximate) for o in result.date_options}
    # 10-го — перевірена жива ціна з відомим прильотом: ночі точні (модуль 22).
    assert nights == {(5, 6, True), (10, 4, False)}


async def test_matrix_uses_cached_sources_only_and_keeps_cheapest_per_cell() -> None:
    d = date
    cached = StubProvider(
        "cached",
        offers=[
            on("cached", 120, d(2026, 12, 5), d(2026, 12, 12)),
            on("cached", 100, d(2026, 12, 5), d(2026, 12, 12), idx=1),  # та сама клітинка
            on("cached", 90, d(2026, 12, 6), d(2026, 12, 11)),
            on("cached", 80, d(2026, 12, 20), d(2026, 12, 27)),  # поза матрицею
            on("cached", 70, d(2026, 12, 5), None),  # в один бік — не для матриці
        ],
    )
    live = StubProvider("live", offers=offers_for("live", [10]))

    matrix = await service(live, cached).matrix(
        "WAW", "LIS", (d(2026, 12, 3), d(2026, 12, 7)), (d(2026, 12, 10), d(2026, 12, 14)), "EUR"
    )

    assert live.calls == 0  # жодного живого запиту
    assert [(c.departure.day, c.return_date.day, int(c.price)) for c in matrix.cells] == [
        (5, 12, 100),
        (6, 11, 90),
    ]
    assert (len(matrix.departures), len(matrix.returns)) == (5, 5)
    [query] = cached.queries
    assert query.nights_range == (1, 30)


async def test_matrix_endpoint_limits_ranges(client: AsyncClient) -> None:
    base = "/flights/matrix?origin=WAW&destination=LIS"
    too_wide = await client.get(
        f"{base}&depart_from=2026-12-01&depart_to=2026-12-20&return_from=2026-12-10&return_to=2026-12-12"
    )
    backwards = await client.get(
        f"{base}&depart_from=2026-12-10&depart_to=2026-12-12&return_from=2026-12-01&return_to=2026-12-05"
    )
    ok = await client.get(
        f"{base}&depart_from=2026-12-03&depart_to=2026-12-07&return_from=2026-12-10&return_to=2026-12-14"
    )
    assert (too_wide.status_code, backwards.status_code, ok.status_code) == (422, 422, 200)
    assert len(ok.json()["departures"]) == 5
