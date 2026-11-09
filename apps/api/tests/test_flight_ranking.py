"""Модуль 14 (перельоти): спершу обов'язкові вимоги, потім ранжування; нові фактори скорингу
і відтворювані причини «Чому цей варіант?». Очікувані суми пораховані вручну за config.toml."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from flight_fakes import StubProvider
from tickets_api.domain.flights import (
    BagAllowance,
    Baggage,
    FlightPreferences,
    FlightQuery,
    Layover,
    Leg,
    Offer,
    OfferFilters,
    Segment,
)
from tickets_api.scoring.baggage import baggage_cost
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.engine import Reason, offer_key, score_offers
from tickets_api.services.flight_search import FlightSearchService, requirement_violations

CONFIG = default_scoring_config()
T = datetime(2026, 11, 10, 10, 0, tzinfo=UTC)
QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))


def offer(
    id_: str,
    *,
    price: int,
    duration: int = 300,
    departure: datetime = T,
    stops: int = 0,
    layovers: list[Layover] | None = None,
    segments: list[Segment] | None = None,
    airlines: tuple[str, ...] = ("LO",),
    baggage: Baggage | None = None,
) -> Offer:
    return Offer(
        id=id_,
        source="t",
        price=Decimal(price),
        currency="EUR",
        outbound=Leg(
            origin="WAW",
            destination="LIS",
            departure_at=departure,
            arrival_at=departure + timedelta(minutes=duration),
            duration_min=duration,
            stops=stops,
            layovers=layovers if layovers is not None else ([] if stops == 0 else None),
            segments=segments,
        ),
        airlines=list(airlines),
        details_level="full",
        baggage=baggage,
        collected_at=T,
    )


def reasons(offers: list[Offer], key: str, **kwargs: object) -> list[Reason]:
    result = score_offers(offers, "balanced", CONFIG, **kwargs)  # type: ignore[arg-type]
    return next(s for s in result.scores if s.offer_key == f"t:{key}").reasons


# --- 14.1: обов'язкові вимоги ----------------------------------------------------------------


def test_direct_only_is_enforced_even_if_a_source_ignores_it() -> None:
    query = QUERY.model_copy(update={"direct_only": True})
    assert requirement_violations(offer("c", price=50, stops=1), query) == ["direct"]
    assert requirement_violations(offer("d", price=90), query) == []


def test_filter_violations_name_each_broken_filter() -> None:
    f = OfferFilters(max_stops=0, max_price=100, airlines=["FR"])
    o = offer("x", price=150, stops=1, airlines=("LO",))
    assert f.violations(o) == ["stops", "airlines", "price"]
    assert not f.matches(o)


def test_fare_without_the_required_bag_is_excluded_but_unknown_is_not() -> None:
    query = QUERY.model_copy(update={"baggage": "checked"})
    no_bag = Baggage(checked=BagAllowance(status="not_available"))
    assert requirement_violations(offer("a", price=50, baggage=no_bag), query) == ["baggage"]
    assert requirement_violations(offer("b", price=50), query) == []  # невідомо — не відсікаємо


async def test_cheaper_connection_is_never_recommended_with_direct_only() -> None:
    connection = offer("conn", price=40, duration=400, stops=1)
    direct = offer("direct", price=120, duration=180)
    service = FlightSearchService(
        [StubProvider("t", offers=[connection, direct])],
        timeout_s=1,
        scoring_config=CONFIG,
    )

    result = await service.search(QUERY.model_copy(update={"direct_only": True}))

    assert [o.id for o in result.offers] == ["direct"]
    assert {p.offer_key for p in result.scoring.picks} == {"t:direct"}
    assert [(e.reason, e.offers) for e in result.excluded] == [("direct", 1)]


async def test_excluded_counts_by_first_violated_requirement() -> None:
    service = FlightSearchService(
        [
            StubProvider(
                "t",
                offers=[
                    offer("a", price=50, stops=1),
                    offer("b", price=500),
                    offer("c", price=600, stops=1),
                    offer("ok", price=90),
                ],
            )
        ],
        timeout_s=1,
        scoring_config=CONFIG,
    )
    query = QUERY.model_copy(update={"filters": OfferFilters(max_stops=0, max_price=200)})

    result = await service.search(query)

    assert [o.id for o in result.offers] == ["ok"]
    assert [(e.reason, e.offers) for e in result.excluded] == [("stops", 2), ("price", 1)]


# --- 14.2: фактори -------------------------------------------------------------------------


def test_night_arrival_is_penalised() -> None:
    late = offer("late", price=100, departure=datetime(2026, 11, 10, 22, 0, tzinfo=UTC))
    [score] = score_offers([late], "balanced", CONFIG).scores
    assert [(r.code, r.airport) for r in score.breakdown.risk_penalties] == [
        ("night_arrival", "LIS")
    ]
    assert score.breakdown.total == Decimal("120.00")  # 100 + 20 (03:00 — уночі)


def test_airport_change_comes_from_segments() -> None:
    def seg(origin: str, destination: str, start: datetime) -> Segment:
        return Segment(
            origin=origin,
            destination=destination,
            departure_at=start,
            arrival_at=start + timedelta(minutes=90),
            carrier="FR",
            flight_number="FR1",
            duration_min=90,
        )

    o = offer(
        "lon",
        price=100,
        stops=1,
        layovers=[Layover(airport="LGW", duration_min=180, overnight=False, self_transfer=True)],
        segments=[seg("WAW", "LGW", T), seg("STN", "LIS", T + timedelta(hours=4))],
    )
    [score] = score_offers([o], "balanced", CONFIG).scores
    codes = [(r.code, r.airport) for r in score.breakdown.risk_penalties]
    assert ("airport_change", "LGW→STN") in codes
    # 100 + 30 (пересадка) + 50 (окремі квитки) + 40 (зміна аеропорту)
    assert score.breakdown.total == Decimal("220.00")


def test_known_baggage_fee_counts_in_the_score_unknown_only_warns() -> None:
    fee = Baggage(
        personal_item=BagAllowance(status="included"),
        checked=BagAllowance(status="fee", fee=Decimal(35)),
    )
    cheap_with_fee = offer("fee", price=100, baggage=fee)
    unknown = offer("unknown", price=110)
    query_bags = {
        offer_key(o): baggage_cost(o, "checked", QUERY.passengers)
        for o in (cheap_with_fee, unknown)
    }
    result = score_offers([cheap_with_fee, unknown], "balanced", CONFIG, baggage=query_bags)
    by_key = {s.offer_key: s.breakdown for s in result.scores}
    assert by_key["t:fee"].baggage_extra == Decimal(35)
    assert by_key["t:fee"].total == Decimal("135.00")
    assert by_key["t:unknown"].baggage_extra is None
    assert by_key["t:unknown"].total == Decimal("110.00")


def test_personal_preferences_are_soft() -> None:
    prefs = FlightPreferences(airlines=["LO"], departure_periods=["morning"])
    evening_other = offer(
        "eve", price=100, departure=datetime(2026, 11, 10, 18, 0, tzinfo=UTC), airlines=("FR",)
    )
    morning_lo = offer("morn", price=100, departure=datetime(2026, 11, 10, 8, 0, tzinfo=UTC))
    result = score_offers([evening_other, morning_lo], "balanced", CONFIG, preferences=prefs)
    by_key = {s.offer_key: s for s in result.scores}

    assert len(result.scores) == 2  # не фільтр: обидва лишаються у видачі
    assert by_key["t:eve"].breakdown.preference_misses == ["airline", "departure_time"]
    assert by_key["t:eve"].breakdown.preference_penalty == Decimal("25.00")  # 15 + 10
    assert by_key["t:morn"].breakdown.preference_penalty == Decimal("0.00")
    assert [r.code for r in by_key["t:morn"].reasons] == [
        "best_balance",
        "preferred_airline",
        "preferred_time",
    ]


# --- 14.5: «Чому цей варіант?» -----------------------------------------------------------------


def test_pricier_but_faster_says_how_much_and_how_long() -> None:
    cheap = offer("cheap", price=100, duration=480, stops=1)
    fast = offer("fast", price=125, duration=240)

    got = reasons([cheap, fast], "fast")

    assert Reason(code="pricier_but_faster", vs="cheapest", amount=Decimal(25), minutes=240) in got
    assert Reason(code="fewer_stops", vs="cheapest", count=1) in got


def test_cheaper_but_slower_compares_with_the_fastest() -> None:
    cheap = offer("cheap", price=100, duration=480, stops=1)
    fast = offer("fast", price=180, duration=240)

    got = reasons([cheap, fast], "cheap")

    assert got[0] == Reason(code="cheapest", count=2)
    assert Reason(code="cheaper_but_slower", vs="fastest", amount=Decimal(80), minutes=240) in got


def test_avoided_risks_of_the_cheapest_are_named() -> None:
    risky = offer(
        "risky",
        price=90,
        stops=1,
        layovers=[Layover(airport="ZRH", duration_min=40, overnight=False, self_transfer=True)],
    )
    safe = offer(
        "safe",
        price=110,
        stops=1,
        layovers=[Layover(airport="AMS", duration_min=120, overnight=False, self_transfer=False)],
    )

    got = reasons([risky, safe], "safe")

    assert {r.risk for r in got if r.code == "avoids_risk"} == {"short_layover", "self_transfer"}


def test_tiny_time_difference_is_not_called_a_saving() -> None:
    cheap = offer("cheap", price=100, duration=300)
    other = offer("other", price=110, duration=280)
    assert not [r for r in reasons([cheap, other], "other") if r.code == "pricier_but_faster"]


def test_single_offer_has_only_option_reason() -> None:
    assert reasons([offer("one", price=100)], "one") == [Reason(code="only_option")]


def test_reasons_are_reproducible() -> None:
    offers = [offer("a", price=100, duration=480, stops=1), offer("b", price=140, duration=200)]
    first = score_offers(offers, "balanced", CONFIG)
    second = score_offers(list(reversed(offers)), "balanced", CONFIG)
    assert {s.offer_key: s.reasons for s in first.scores} == {
        s.offer_key: s.reasons for s in second.scores
    }
