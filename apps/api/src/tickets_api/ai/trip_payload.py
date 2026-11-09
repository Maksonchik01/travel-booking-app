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
    "cheapest": "Економ",
    "best_value": "Оптимальний",
    "comfort": "Комфорт",
}
"""Ті самі назви, що в UI (messages/uk.json → tripPicks.label)."""


def trip_input(result: TripSearchResult, airline_names: dict[str, str]) -> dict[str, Any]:
    q = result.query
    combos = {c.key: c for c in result.combos}
    offers = {f"{o.source}:{o.id}": o for o in result.offers}
    options = []
    for pick in result.picks:
        combo = combos[pick.combo_key]
        options.append(
            _option(
                pick, combo, offers[combo.offer_key], result.stays[combo.stay_index], airline_names
            )
        )
    labels = [p.label for p in result.picks]
    budget = result.budget
    return {
        "query": {
            "origin": q.origin,
            "destination": q.destination,
            "departure_date": q.departure_date.isoformat(),
            "return_date": q.return_date.isoformat() if q.return_date else None,
            "nights": list(q.nights_range) if q.nights_range else None,
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
        "note": (
            "flight prices are for all travellers (adults and children); "
            "stays — whole room with taxes; money_total_text = confirmed + approximate parts, "
            "unknown parts are not included"
        ),
    }


def _option(
    pick: TripPick,
    combo: TripCombo,
    offer: Offer,
    stay: Any,
    airline_names: dict[str, str],
) -> dict[str, Any]:
    return {
        "id": pick.label,
        "title": TRIP_TITLES[pick.label],
        "also": [TRIP_TITLES[label] for label in pick.also],
        "over_budget": pick.over_budget,
        **combo_facts(combo, offer, stay, airline_names),
    }


def combo_facts(
    combo: TripCombo, offer: Offer, stay: Any, airline_names: dict[str, str]
) -> dict[str, Any]:
    """Одна поїздка текстами для моделі: суми, розбивка, рейс, житло, попередження."""
    currency = combo.currency
    costs = combo.costs
    parts = [f"квитки {money_text(combo.flight_price, currency)}"]
    for item in costs.items:
        if item.kind == "baggage":
            parts.append(
                "багаж — невідомо"
                if item.amount is None
                else f"багаж {money_text(item.amount, currency)}"
            )
        elif item.kind == "stay":
            parts.append(
                f"житло {money_text(combo.stay_total, currency)} за {combo.window.nights} ноч."
            )
        elif item.kind == "extra" and item.amount is not None:
            parts.append(f"{item.label} {money_text(item.amount, currency)}")
    return {
        "money_total_text": money_text(combo.money_total, currency),
        "breakdown_text": " + ".join(parts),
        "confirmed_text": money_text(costs.confirmed, currency),
        "approximate_text": money_text(costs.approximate, currency),
        "unknown_parts": costs.unknown,
        "prices_cached": offer.price_status != "live",
        "flight": {
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
            "nights": combo.window.nights,
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
