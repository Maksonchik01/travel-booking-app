"""Модуль 14b: житло (зручності, бюджет, причини) і поїздка цілком (повноцінні ночі, час у
дорозі, причини). Суми пораховані вручну за stays.toml і trip.toml."""

from datetime import date
from decimal import Decimal

from flight_fakes import StubProvider
from test_stay_scoring import CONFIG, stay
from test_trip_planner import DAY, NIGHT, STUB_QUERY, planner, round_trip
from tickets_api.domain.stays import StayFilters, StayPreferences
from tickets_api.domain.trips import TripPreferences
from tickets_api.scoring.stays import StayReason, score_stay, score_stays

# --- 14.3: житло ---------------------------------------------------------------------------


def test_missing_preferred_amenity_is_a_soft_penalty() -> None:
    prefs = StayPreferences(amenities=["wifi", "parking"])
    with_wifi = stay("a", amenities=["wifi"])
    unknown = stay("b")  # джерело зручностей не дало — невідомо, не «немає»

    scored = score_stay(with_wifi, "balanced", CONFIG, prefs).breakdown
    assert scored.missing_amenities == ["parking"]
    assert scored.amenity_penalty == Decimal("4.00")
    assert scored.total == Decimal("104.45")  # 100,45 ідеального + 4
    assert score_stay(unknown, "balanced", CONFIG, prefs).breakdown.amenity_penalty == 0


def test_stay_reasons_compare_with_cheapest_in_total_money() -> None:
    cheap = stay(
        "cheap",
        price_per_night=Decimal(80),
        total_price=Decimal(240),
        distance_to_center_km=Decimal("4.0"),
        rating=Decimal("7.4"),
        cancellation="non_refundable",
    )
    central = stay("central", total_price=Decimal(270), distance_to_center_km=Decimal("0.6"))

    result = score_stays([cheap, central], "balanced", CONFIG)
    reasons = next(s for s in result.scores if s.stay_key == "t:central").reasons

    assert (
        StayReason(code="pricier_but_closer", vs="cheapest", amount=Decimal(30), km=Decimal("3.4"))
        in reasons
    )
    better = next(r for r in reasons if r.code == "pricier_but_better_rated")
    assert better.amount == Decimal(30)
    assert better.rating is not None
    assert better.rating > 1
    assert StayReason(code="free_cancellation", vs="cheapest") in reasons


def test_cheaper_than_top_rated_and_budget_headroom() -> None:
    cheap = stay("cheap", price_per_night=Decimal(70), total_price=Decimal(210), rating=Decimal(8))
    top = stay("top", total_price=Decimal(300), rating=Decimal("9.5"))

    result = score_stays([cheap, top], "balanced", CONFIG, budget=Decimal(250))
    reasons = next(s for s in result.scores if s.stay_key == "t:cheap").reasons

    cheaper = next(r for r in reasons if r.code == "cheaper_than_top_rated")
    assert cheaper.amount == Decimal(90)
    assert StayReason(code="within_budget", amount=Decimal(40)) in reasons


def test_budget_from_filters_is_the_strictest_limit() -> None:
    assert StayFilters(max_price_per_night=100, max_total_price=250).budget_for(3) == Decimal(250)
    assert StayFilters(max_price_per_night=80).budget_for(3) == Decimal(240)
    assert StayFilters().budget_for(3) is None


def test_preferred_amenities_reason_when_all_present() -> None:
    prefs = StayPreferences(amenities=["wifi"])
    result = score_stays(
        [stay("a", amenities=["wifi", "pool"])], "balanced", CONFIG, preferences=prefs
    )
    assert [r.code for r in result.scores[0].reasons] == ["only_option", "preferred_amenities"]


# --- 14.4: поїздка цілком ------------------------------------------------------------------


async def test_trip_counts_full_nights_and_travel_time() -> None:
    late = round_trip(
        "late",
        250,
        ("2026-12-05T20:00:00+01:00", "2026-12-05T23:30:00+00:00"),
        ("2026-12-08T06:00:00+00:00", "2026-12-08T11:30:00+01:00"),
    )
    result = await planner(flight_providers=[StubProvider("stub", [late, DAY])]).plan(STUB_QUERY)

    late_combo = next(c for c in result.combos if c.offer_key == "stub:late")
    assert late_combo.window.nights == 3
    assert late_combo.full_nights == 1  # пізній приліт і ранній виліт з'їдають дві ночі
    assert late_combo.travel_min == 400
    assert late_combo.waiting_min == 0
    day = next(c for c in result.combos if c.offer_key == "stub:day")
    assert day.full_nights == 3
    assert any(r.code == "more_full_nights" and r.count == 2 for r in day.reasons)


async def test_trip_reasons_and_budget() -> None:
    slow = round_trip(
        "slow",
        200,
        ("2026-12-05T09:00:00+01:00", "2026-12-05T16:00:00+00:00"),
        ("2026-12-08T09:00:00+00:00", "2026-12-08T17:00:00+01:00"),
        stops=2,
    )
    result = await planner(flight_providers=[StubProvider("stub", [slow, DAY])]).plan(
        STUB_QUERY.model_copy(update={"budget_total": 5000})
    )

    by_offer = {c.offer_key: c for c in result.combos if c.stay_key == result.combos[0].stay_key}
    fast = by_offer["stub:day"]
    gain = next(r for r in fast.reasons if r.code == "pricier_but_faster")
    assert gain.vs == "cheapest"
    assert gain.minutes == (200 + 180) * 2 - 400
    assert any(r.code == "fewer_stops" and r.count == 4 for r in fast.reasons)
    assert all(any(r.code == "within_budget" for r in c.reasons) for c in result.combos)
    cheap = by_offer["stub:slow"]
    assert any(r.code == "cheapest" for r in cheap.reasons) or any(
        r.code == "cheaper_than_comfort" for r in cheap.reasons
    )


async def test_trip_preferences_reach_flight_and_stay_scoring() -> None:
    prefs = TripPreferences(
        stays=StayPreferences(amenities=["pool"]),
    )
    result = await planner(flight_providers=[StubProvider("stub", [NIGHT, DAY])]).plan(
        STUB_QUERY.model_copy(update={"preferences": prefs})
    )
    assert result.stay_queries[0].preferences == prefs.stays
    assert result.flight_query.preferences is None


async def test_selected_trip_has_reasons() -> None:
    result = await planner(flight_providers=[StubProvider("stub", [NIGHT, DAY])]).plan(
        STUB_QUERY.model_copy(update={"flight": "stub:day"})
    )
    assert result.selected is not None
    assert result.selected.reasons
    assert result.selected.window.check_in == date(2026, 12, 5)
