"""Вхідні дані про поїздку для моделі: суми й розбивки вже пораховані кодом, текстом."""

from typing import Any

from tickets_api.ai.explainer import duration_text, money_text
from tickets_api.ai.stay_payload import stay_facts
from tickets_api.domain.flights import Leg, Offer
from tickets_api.services.trip_planner import (
    TripCombo,
    TripPick,
    TripPickLabel,
    TripSearchResult,
)

TRIP_TITLES: dict[TripPickLabel, str] = {
    "cheapest": "Найдешевша поїздка",
    "best_value": "Найвигідніша поїздка",
    "comfort": "Найзручніша поїздка",
}
"""Ті самі назви, що в UI (messages/uk.json → tripPicks.label)."""


def trip_input(result: TripSearchResult, airline_names: dict[str, str]) -> dict[str, Any]:
    q = result.query
    combos = {c.key: c for c in result.combos}
    offers = {f"{o.source}:{o.id}": o for o in result.offers}
    stays = {f"{s.source}:{s.id}": s for s in result.stays}
    options = []
    for pick in result.picks:
        combo = combos[pick.combo_key]
        options.append(
            _option(
                pick, combo, offers[combo.offer_key], stays[combo.stay_key], airline_names, q.adults
            )
        )
    labels = [p.label for p in result.picks]
    budget = result.budget
    return {
        "query": {
            "origin": q.origin,
            "destination": q.destination,
            "departure_date": q.departure_date.isoformat(),
            "return_date": q.return_date.isoformat(),
            "adults": q.adults,
            "children": q.children,
            "priority": q.profile,
        },
        "options": options,
        "recommended_by_scoring": "best_value"
        if "best_value" in labels
        else next(iter(labels), None),
        "budget": None
        if budget is None
        else {
            "budget_text": money_text(budget.budget, q.currency),
            "combinations_within_budget": budget.within,
            "shortfall_text": money_text(budget.shortfall, q.currency)
            if budget.shortfall is not None
            else None,
        },
        "combinations_checked": len(result.combos),
        "flights_found": result.flights_found,
        "sources_failed": [p.provider for p in result.providers if p.status != "ok"],
        "note": "flight prices are per adult (no child fares); stays — whole room with taxes",
    }


def _option(
    pick: TripPick,
    combo: TripCombo,
    offer: Offer,
    stay: Any,
    airline_names: dict[str, str],
    adults: int,
) -> dict[str, Any]:
    currency = combo.currency
    flight_part = (
        f"переліт {adults} × {money_text(combo.flight_price, currency)}"
        if adults > 1
        else f"переліт {money_text(combo.flight_total, currency)}"
    )
    return {
        "id": pick.label,
        "title": TRIP_TITLES[pick.label],
        "also": [TRIP_TITLES[label] for label in pick.also],
        "money_total_text": money_text(combo.money_total, currency),
        "breakdown_text": f"{flight_part} + житло {money_text(combo.stay_total, currency)} "
        f"за {combo.window.nights} ноч.",
        "flight": {
            "price_per_adult_text": money_text(combo.flight_price, currency),
            "flight_total_text": money_text(combo.flight_total, currency),
            "airlines": [airline_names.get(c, c) for c in offer.airlines],
            "stops": offer.stops,
            "duration_text": duration_text(offer.total_duration_min),
            "outbound": _leg(offer.outbound),
            "inbound": _leg(offer.inbound) if offer.inbound else None,
        },
        "stay": {
            **stay_facts(stay),
            "check_in": combo.window.check_in.isoformat(),
            "check_out": combo.window.check_out.isoformat(),
        },
        "warnings": combo.warnings,
    }


def _leg(leg: Leg) -> dict[str, Any]:
    return {
        "from": leg.origin,
        "to": leg.destination,
        "departure_local": leg.departure_at.strftime("%Y-%m-%d %H:%M"),
        "arrival_local": leg.arrival_at.strftime("%Y-%m-%d %H:%M") if leg.arrival_at else None,
        "stops": leg.stops,
    }
