from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from flight_fakes import StubProvider
from httpx import AsyncClient
from pydantic import ValidationError
from tickets_api.domain.flights import BagAllowance, Baggage, Leg, Offer
from tickets_api.domain.saved_trips import TripRefreshRequest
from tickets_api.domain.stays import StayFilters
from tickets_api.domain.trips import TripExtra, TripQuery
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.scoring.trip import default_trip_scoring_config, timing
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import (
    TripPlanner,
    TripSearchResult,
    flight_query_for,
    stay_window,
)

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
QUERY = TripQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 5),
    return_date=date(2026, 12, 8),
)


def planner(
    stay_providers: list[Any] | None = None, flight_providers: list[Any] | None = None
) -> TripPlanner:
    flights = FlightSearchService(
        flight_providers or [MockFlightProvider(clock=lambda: NOW)],
        timeout_s=1,
        scoring_config=default_scoring_config(),
    )
    stays = StaySearchService(
        stay_providers
        if stay_providers is not None
        else [MockStayProvider(default_airport_directory(), clock=lambda: NOW)],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
    )
    return TripPlanner(flights, stays)


def leg(dep: str, arr: str) -> Leg:
    return Leg(
        origin="WAW",
        destination="LIS",
        departure_at=datetime.fromisoformat(dep),
        arrival_at=datetime.fromisoformat(arr),
        stops=0,
    )


def test_query_needs_return_after_departure() -> None:
    with pytest.raises(ValidationError):
        TripQuery(
            origin="WAW",
            destination="LIS",
            departure_date=date(2026, 12, 5),
            return_date=date(2026, 12, 5),
        )
    with pytest.raises(ValidationError):
        TripQuery(
            origin="WAW",
            destination="WAW",
            departure_date=date(2026, 12, 5),
            return_date=date(2026, 12, 8),
        )


def test_stay_window_is_from_arrival_to_return_departure_in_local_dates() -> None:
    offer = Offer(
        id="x",
        source="t",
        price=Decimal(100),
        currency="EUR",
        # Виліт 5-го ввечері, приліт уже 6-го о 01:30 — ніч з 5 на 6 житло не потрібне.
        outbound=leg("2026-12-05T21:00:00+01:00", "2026-12-06T01:30:00+00:00"),
        inbound=leg("2026-12-09T10:00:00+00:00", "2026-12-09T15:00:00+01:00"),
        airlines=["LO"],
        details_level="full",
        collected_at=NOW,
    )

    assert stay_window(offer) == (date(2026, 12, 6), date(2026, 12, 9))
    assert stay_window(offer.model_copy(update={"inbound": None})) is None


async def test_combos_totals_and_picks() -> None:
    result = await planner().plan(QUERY.model_copy(update={"adults": 2}))

    assert result.combos
    offers = {f"{o.source}:{o.id}": o for o in result.offers}
    for combo in result.combos:
        offer, stay = offers[combo.offer_key], result.stays[combo.stay_index]
        # Ціна перельоту вже за обох дорослих (ADR 0013) — не множимо вдруге.
        assert combo.flight_total == offer.price
        assert combo.stay_total == stay.total_price
        assert combo.money_total == combo.flight_total + combo.stay_total
        assert stay.nights == combo.window.nights
        assert (combo.window.check_in, combo.window.check_out) == stay_window(offer)
    # Найвигідніша — перша; три номінації.
    assert result.picks
    labels = {p.label for p in result.picks} | {a for p in result.picks for a in p.also}
    assert labels == {"cheapest", "best_value", "comfort"}
    cheapest = next(c for c in result.combos if c.key == _pick(result, "cheapest"))
    assert cheapest.money_total == min(c.money_total for c in result.combos)
    assert result.combos[0].key == _pick(result, "best_value")


async def test_budget_filters_picks_or_reports_shortfall() -> None:
    full = await planner().plan(QUERY)
    cheapest = min(c.money_total for c in full.combos)

    tight = await planner().plan(QUERY.model_copy(update={"budget_total": int(cheapest) + 1}))
    impossible = await planner().plan(QUERY.model_copy(update={"budget_total": 10}))

    assert tight.budget is not None
    assert tight.budget.within >= 1
    assert all(
        c.money_total <= tight.budget.budget
        for c in tight.combos
        if c.key in {p.combo_key for p in tight.picks}
    )
    assert impossible.budget is not None
    assert impossible.budget.within == 0
    assert impossible.budget.shortfall == cheapest - 10


async def test_children_are_priced_and_stays_failure_keeps_flights() -> None:
    alone = await planner().plan(QUERY.model_copy(update={"adults": 1}))
    with_kid = await planner().plan(QUERY.model_copy(update={"adults": 1, "children": 1}))
    # Дитячий тариф рахує джерело: переліт дорожчий, але не вдвічі (mock: дитина — 75 %).
    assert (
        min(c.flight_total for c in alone.combos)
        < min(c.flight_total for c in with_kid.combos)
        < 2 * min(c.flight_total for c in alone.combos)
    )

    class Broken:
        name = "broken"

        async def search(self, query: Any) -> list[Any]:
            raise RuntimeError("down")

        async def reviews(self, stay_id: str, *, limit: int = 30) -> list[Any]:
            return []

    no_stays = await planner([Broken()]).plan(QUERY)
    assert no_stays.combos == []
    assert no_stays.flights_found > 0
    assert any(p.provider == "broken" and p.status == "error" for p in no_stays.providers)


async def test_trips_api(client: AsyncClient) -> None:
    body = {
        "origin": "waw",
        "destination": "lis",
        "departure_date": "2026-12-05",
        "return_date": "2026-12-08",
    }

    data = (await client.post("/trips/search", json=body)).json()

    assert data["picks"]
    assert data["combos"][0]["money_total"] > 0
    bad = {**body, "return_date": "2026-12-01"}
    assert (await client.post("/trips/search", json=bad)).status_code == 422


def _pick(result: TripSearchResult, label: str) -> str:
    return next(p.combo_key for p in result.picks if p.label == label or label in p.also)


async def test_pinned_stay_is_used_where_available() -> None:
    result = await planner().plan(QUERY.model_copy(update={"stay": "mock:mock-lis-5"}))

    assert result.pinned_stay == "used"
    assert result.combos
    assert {c.stay_key for c in result.combos} == {"mock:mock-lis-5"}
    # Житло, якого немає на ці дати (інше місто), — звичайний вибір і чесне «unavailable».
    other = await planner().plan(QUERY.model_copy(update={"stay": "mock:mock-waw-5"}))
    assert other.pinned_stay == "unavailable"
    assert len({c.stay_key for c in other.combos}) > 1
    assert (await planner().plan(QUERY)).pinned_stay is None
    with pytest.raises(ValidationError):
        TripQuery.model_validate({**QUERY.model_dump(), "stay": "javascript:alert(1)"})


def round_trip(
    oid: str,
    price: int,
    out: tuple[str, str],
    back: tuple[str, str],
    *,
    stops: int = 0,
    status: str = "live",
    baggage: Baggage | None = None,
) -> Offer:
    def one(dep: str, arr: str, origin: str, destination: str) -> Leg:
        return Leg(
            origin=origin,
            destination=destination,
            departure_at=datetime.fromisoformat(dep),
            arrival_at=datetime.fromisoformat(arr),
            duration_min=200 + 90 * stops,
            stops=stops,
        )

    return Offer(
        id=oid,
        source="stub",
        price=Decimal(price),
        currency="EUR",
        outbound=one(*out, "WAW", "LIS"),
        inbound=one(*back, "LIS", "WAW"),
        airlines=["LO"],
        details_level="full",
        price_status=status,
        baggage=baggage,
        collected_at=NOW,
    )


# Нічний рейс: виліт 4-го о 23:40, приліт 5-го о 02:10 — житло з 5-го, а не з 4-го.
NIGHT = round_trip(
    "night",
    300,
    ("2026-12-04T23:40:00+01:00", "2026-12-05T02:10:00+00:00"),
    ("2026-12-08T12:00:00+00:00", "2026-12-08T17:30:00+01:00"),
)
DAY = round_trip(
    "day",
    420,
    ("2026-12-05T09:00:00+01:00", "2026-12-05T11:40:00+00:00"),
    ("2026-12-08T14:00:00+00:00", "2026-12-08T19:30:00+01:00"),
)
STUB_QUERY = QUERY.model_copy(update={"departure_date": date(2026, 12, 4)})


async def test_overnight_flight_books_stay_from_arrival_date_with_warning() -> None:
    result = await planner(flight_providers=[StubProvider("stub", [NIGHT, DAY])]).plan(STUB_QUERY)

    night = [c for c in result.combos if c.offer_key == "stub:night"]
    assert night
    for combo in night:
        assert (combo.window.check_in, combo.window.check_out) == (
            date(2026, 12, 5),
            date(2026, 12, 8),
        )
        assert combo.window.nights == 3
        assert "night_arrival" in combo.warnings
        assert combo.arrival_at == NIGHT.outbound.arrival_at
        stay = result.stays[combo.stay_index]
        assert stay.nights == 3
        assert stay.total_price == combo.stay_total
    # Обидва рейси прилітають 5-го — одне вікно, один запит житла.
    assert [(q.check_in, q.check_out) for q in result.stay_queries] == [
        (date(2026, 12, 5), date(2026, 12, 8))
    ]


async def test_costs_split_confirmed_approximate_unknown() -> None:
    cached = NIGHT.model_copy(update={"id": "cached", "price_status": "cached"})
    bags = Baggage(
        personal_item=BagAllowance(status="included"),
        carry_on=BagAllowance(status="included"),
        checked=BagAllowance(status="fee", fee=Decimal(40)),
    )
    paid = DAY.model_copy(update={"baggage": bags})
    query = STUB_QUERY.model_copy(
        update={
            "baggage": "checked",
            "extras": [TripExtra(label="Музей", amount=Decimal(30))],
        }
    )
    result = await planner(flight_providers=[StubProvider("stub", [cached, paid])]).plan(query)

    by_offer = {c.offer_key: c for c in result.combos}
    paid_combo, cached_combo = by_offer["stub:day"], by_offer["stub:cached"]
    kinds = {i.kind: i for i in paid_combo.costs.items}
    assert kinds["tickets"].status == "confirmed"
    assert kinds["baggage"].amount == Decimal(40) * 2  # два дорослі
    assert kinds["extra"].status == "approximate"
    assert paid_combo.costs.confirmed == 420 + 80 + paid_combo.stay_total
    assert paid_combo.costs.approximate == Decimal(30)
    assert paid_combo.money_total == paid_combo.costs.confirmed + 30
    assert paid_combo.flight_total == 500
    # Кешована ціна — орієнтовна; багаж без даних — невідомий і в суму не входить.
    cached_items = {i.kind: i for i in cached_combo.costs.items}
    assert cached_items["tickets"].status == "approximate"
    assert cached_items["baggage"].status == "unknown"
    assert cached_items["baggage"].amount is None
    assert cached_combo.costs.unknown == 1
    assert "costs_unknown" in cached_combo.warnings
    assert cached_combo.money_total == 300 + cached_combo.stay_total + 30
    # Економ — серед повністю відомих сум, хоч кешований і дешевший на вигляд.
    assert by_offer[_pick(result, "cheapest").split("|")[0]].offer_key == "stub:day"


async def test_fare_without_needed_baggage_is_not_a_candidate() -> None:
    no_bag = DAY.model_copy(
        update={"baggage": Baggage(checked=BagAllowance(status="not_available"))}
    )
    query = STUB_QUERY.model_copy(update={"baggage": "checked"})
    result = await planner(flight_providers=[StubProvider("stub", [no_bag, NIGHT])]).plan(query)

    assert {c.offer_key for c in result.combos} == {"stub:night"}


async def test_comfort_prefers_fewer_stops_and_over_budget_is_flagged() -> None:
    cheap_stops = NIGHT.model_copy(
        update={
            "id": "stops",
            "price": Decimal(150),
            "outbound": NIGHT.outbound.model_copy(update={"stops": 2}),
        }
    )
    result = await planner(flight_providers=[StubProvider("stub", [cheap_stops, DAY])]).plan(
        STUB_QUERY.model_copy(update={"budget_total": 50})
    )

    comfort = next(c for c in result.combos if c.key == _pick(result, "comfort"))
    assert comfort.offer_key == "stub:day"
    assert comfort.stops == 0
    assert all(p.over_budget for p in result.picks)
    # Сценарії не дублюються: однаковий варіант — один, з `also`.
    keys = [p.combo_key for p in result.picks]
    assert len(keys) == len(set(keys))


async def test_single_option_gives_single_scenario() -> None:
    query = STUB_QUERY.model_copy(update={"stay": "mock:mock-lis-2"})
    result = await planner(flight_providers=[StubProvider("stub", [DAY])]).plan(query)

    assert len(result.combos) == 1
    assert len(result.picks) == 1
    assert set(result.picks[0].also) == {"cheapest", "comfort"}
    assert result.picks[0].label == "best_value"


async def test_stay_wishes_are_mandatory() -> None:
    query = QUERY.model_copy(update={"stay_filters": StayFilters(min_rating=8.5)})
    result = await planner().plan(query)

    assert result.combos
    assert all(s.rating is not None and s.rating >= Decimal("8.5") for s in result.stays)
    assert all(q.filters.min_rating == 8.5 for q in result.stay_queries)


def test_flexible_period_and_duration() -> None:
    with pytest.raises(ValidationError):  # ні повернення, ні тривалості
        TripQuery(origin="WAW", destination="LIS", departure_date=date(2026, 12, 5))
    with pytest.raises(ValidationError):
        TripQuery.model_validate(
            {**QUERY.model_dump(), "min_nights": 5, "max_nights": 3, "return_date": None}
        )
    query = TripQuery(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 12, 1),
        departure_until=date(2026, 12, 20),
        min_nights=3,
        max_nights=5,
        cabin="business",
        baggage="carry_on",
    )
    flight = flight_query_for(query)
    assert flight.departure_until == date(2026, 12, 20)
    assert flight.nights_range == (3, 5)
    assert flight.return_date == date(2026, 12, 4)
    assert (flight.cabin, flight.baggage) == ("business", "carry_on")
    # Тривалість без періоду — період з одного дня (ночі рахує лише гнучкий пошук).
    fixed = query.model_copy(update={"departure_until": None})
    assert flight_query_for(fixed).departure_until == date(2026, 12, 1)


async def test_flexible_trip_respects_nights_from_arrival() -> None:
    query = QUERY.model_copy(
        update={"return_date": None, "min_nights": 3, "max_nights": 4, "flex_days": 2}
    )
    result = await planner().plan(query)

    assert result.combos
    assert all(3 <= c.window.nights <= 4 for c in result.combos)


def test_timing_penalties_are_facts_from_local_times() -> None:
    config = default_trip_scoring_config()
    penalty, warnings = timing(NIGHT, config)
    assert warnings == ["night_arrival"]
    assert penalty == config.timing.night_arrival
    early = DAY.model_copy(
        update={
            "inbound": DAY.inbound.model_copy(  # type: ignore[union-attr]
                update={"departure_at": datetime.fromisoformat("2026-12-08T06:05:00+00:00")}
            )
        }
    )
    assert timing(early, config)[1] == ["early_return"]
    assert timing(DAY, config) == (Decimal(0), [])  # приліт 11:40, виліт назад о 14:00


async def test_pinned_flight_becomes_your_trip_with_options() -> None:
    base = await planner().plan(QUERY)
    other = base.flight_options[-1]
    result = await planner().plan(QUERY.model_copy(update={"flight": other.offer_key}))

    assert result.pinned_flight == "used"
    selected = result.selected
    assert selected is not None
    assert selected.offer_key == other.offer_key
    assert other.window is not None
    assert selected.window == other.window  # житло — на дати саме цього рейсу
    stay = result.stays[selected.stay_index]
    assert stay.total_price == selected.stay_total
    # Варіанти заміни: рейси є в offers, житло — на ті самі дати.
    keys = {f"{o.source}:{o.id}" for o in result.offers}
    assert {f.offer_key for f in result.flight_options} <= keys
    assert 1 < len(result.stay_options) <= 8
    assert all(result.stays[i].nights == selected.window.nights for i in result.stay_options)


async def test_stay_is_kept_when_compatible_and_replaced_honestly_when_not() -> None:
    base = await planner().plan(QUERY)
    flight = base.flight_options[1].offer_key
    stay = base.stays[base.stay_options[0] if base.stay_options else 0]
    kept = await planner().plan(
        QUERY.model_copy(update={"flight": flight, "stay": f"{stay.source}:{stay.id}"})
    )
    assert kept.selected is not None
    assert kept.selected.stay_key == f"{stay.source}:{stay.id}"
    assert kept.pinned_stay == "used"

    gone = await planner().plan(QUERY.model_copy(update={"flight": flight, "stay": "mock:nope"}))
    assert gone.selected is not None
    assert gone.selected.offer_key == flight
    assert gone.pinned_stay == "unavailable"

    lost = await planner().plan(QUERY.model_copy(update={"flight": "mock:ffffffffffffffff"}))
    assert lost.pinned_flight == "unavailable"
    assert lost.selected is not None  # найкраща комбінація замість обраного рейсу


async def test_cheaper_finds_saving_and_apply_reproduces_it() -> None:
    base = await planner().plan(QUERY)
    # Найдорожчий рейс із найдорожчим житлом його дат — є що здешевити.
    flight = max(base.flight_options, key=lambda f: f.flight_total).offer_key
    pinned = await planner().plan(QUERY.model_copy(update={"flight": flight}))
    assert pinned.selected is not None
    priciest = max((pinned.stays[i] for i in pinned.stay_options), key=lambda s: s.total_price)
    query = QUERY.model_copy(update={"flight": flight, "stay": f"{priciest.source}:{priciest.id}"})

    result = await planner().cheaper(query)

    assert result.status == "found"
    assert result.before is not None
    assert result.after is not None
    assert result.saving == result.before.money_total - result.after.money_total
    assert result.saving is not None
    assert result.saving > 0
    assert result.changes
    assert result.after.window.nights == result.before.window.nights  # тривалість та сама
    assert result.flights_checked > 0
    assert result.apply is not None
    assert result.apply.flight == result.after.offer_key
    assert result.stays[result.after.stay_index].total_price == result.after.stay_total
    applied = await planner().plan(result.apply)
    assert applied.selected is not None
    assert applied.selected.key == result.after.key
    assert applied.selected.money_total == result.after.money_total


async def test_cheaper_says_honestly_when_nothing_found() -> None:
    stub = [StubProvider("stub", [DAY])]
    base = await planner(flight_providers=stub).plan(STUB_QUERY)
    cheapest = min(base.stays, key=lambda s: s.total_price)
    query = STUB_QUERY.model_copy(
        update={"flight": "stub:day", "stay": f"{cheapest.source}:{cheapest.id}"}
    )
    pinned = await planner(flight_providers=stub).plan(query)
    floor = min(pinned.stays[i].total_price for i in pinned.stay_options)
    assert pinned.selected is not None
    if pinned.selected.stay_total > floor:  # обране не найдешевше — беремо найдешевше
        best = min((pinned.stays[i] for i in pinned.stay_options), key=lambda s: s.total_price)
        query = query.model_copy(update={"stay": f"{best.source}:{best.id}"})

    result = await planner(flight_providers=stub).cheaper(query)

    assert result.status == "not_found"
    assert result.after is None
    assert result.before is not None
    assert result.combos_checked > 0


async def test_cheaper_api(client: AsyncClient) -> None:
    body = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": "2026-12-05",
        "return_date": "2026-12-08",
    }
    data = (await client.post("/trips/cheaper", json=body)).json()
    assert data["status"] in {"found", "not_found"}
    assert data["before"]["money_total"] > 0


async def test_cheaper_keeps_stay_kind() -> None:
    flight = (await planner().plan(QUERY)).flight_options[0].offer_key
    base = await planner().plan(QUERY.model_copy(update={"flight": flight}))
    hotel = next(i for i in base.stay_options if base.stays[i].kind == "hotel")
    stay = base.stays[hotel]
    query = QUERY.model_copy(update={"flight": flight, "stay": f"{stay.source}:{stay.id}"})

    result = await planner().cheaper(query)

    assert result.status in {"found", "not_found"}
    if result.status == "found":
        assert result.stays[1].kind == "hotel"


async def test_refresh_reports_current_total_and_availability() -> None:
    base = await planner().plan(QUERY)
    pick = base.combos[0]
    query = QUERY.model_copy(update={"flight": pick.offer_key, "stay": pick.stay_key})

    same = await planner().refresh(TripRefreshRequest(query=query, saved_total=Decimal(100)))

    assert same.current is not None
    assert same.flight_available
    assert same.stay_available
    assert same.difference == pick.money_total - 100
    assert same.stay is not None
    assert same.stay.total_price == same.current.stay_total

    gone = await planner().refresh(
        TripRefreshRequest(
            query=query.model_copy(update={"flight": "mock:ffffffffffffffff"}),
            saved_total=pick.money_total,
        )
    )
    assert gone.current is not None
    assert not gone.flight_available
