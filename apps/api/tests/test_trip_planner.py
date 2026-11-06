from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from tickets_api.domain.flights import Leg, Offer
from tickets_api.domain.trips import TripQuery
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner, TripSearchResult, stay_window

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
QUERY = TripQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 5),
    return_date=date(2026, 12, 8),
)


def planner(stay_providers: list[Any] | None = None) -> TripPlanner:
    flights = FlightSearchService(
        [MockFlightProvider(clock=lambda: NOW)],
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
    stays = {f"{s.source}:{s.id}": s for s in result.stays}
    for combo in result.combos:
        offer, stay = offers[combo.offer_key], stays[combo.stay_key]
        assert combo.flight_total == offer.price * 2
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


async def test_children_are_flagged_and_stays_failure_keeps_flights() -> None:
    with_kids = await planner().plan(QUERY.model_copy(update={"children": 1}))
    assert all("children_not_priced" in c.warnings for c in with_kids.combos)

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
